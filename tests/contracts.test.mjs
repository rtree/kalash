import assert from 'node:assert/strict';
import test from 'node:test';
import { compileContracts } from '../scripts/compile-contracts.mjs';

// This suite uses Ganache's supported Linux Node entry, not a Windows native shim.
test('M1 contracts on an isolated Shanghai chain', { timeout: 180_000 }, async (t) => {
  const artifacts = await compileContracts({ writeArtifacts: false });
  const [{ default: ganache }, viem, { privateKeyToAccount }] = await Promise.all([
    import('ganache'), import('viem'), import('viem/accounts'),
  ]);
  const {
    createPublicClient, createWalletClient, custom, defineChain,
    stringToHex, decodeEventLog, zeroAddress, maxUint256,
  } = viem;
  const chain = defineChain({
    id: 84532, name: 'Isolated M1',
    nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://127.0.0.1'] } },
  });
  const provider = ganache.provider({
    chain: { chainId: chain.id, hardfork: 'shanghai' },
    logging: { quiet: true },
    wallet: { totalAccounts: 7 },
  });
  t.after(async () => { await provider.disconnect(); });
  const accounts = Object.entries(provider.getInitialAccounts()).map(([address, value]) => ({
    address, signer: privateKeyToAccount(value.secretKey),
  }));
  const [deployer, donor, authorizer, temple, fee, outsider, minter] = accounts;
  const publicClient = createPublicClient({ chain, transport: custom(provider), pollingInterval: 10 });
  const wallet = (account) => createWalletClient({
    account: account.address, chain, transport: custom(provider),
  });
  async function deploy(name, args) {
    const hash = await wallet(deployer).deployContract({ ...artifacts[name], args, gas: 8_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${name} deployment`);
    assert.ok(receipt.contractAddress);
    return { address: receipt.contractAddress, abi: artifacts[name].abi };
  }
  async function send(contract, account, functionName, args) {
    const hash = await wallet(account).writeContract({
      ...contract, functionName, args, gas: 1_500_000n,
    });
    return publicClient.waitForTransactionReceipt({ hash });
  }
  async function success(contract, account, functionName, args) {
    const receipt = await send(contract, account, functionName, args);
    assert.equal(receipt.status, 'success', functionName);
    return receipt;
  }
  const read = (contract, functionName, args = []) => publicClient.readContract({
    ...contract, functionName, args,
  });
  function events(receipt, contract, name) {
    return receipt.logs.filter((log) => log.address.toLowerCase() === contract.address.toLowerCase())
      .map((log) => decodeEventLog({ abi: contract.abi, data: log.data, topics: log.topics }))
      .filter((event) => event.eventName === name);
  }
  const templeId = stringToHex('temple-01', { size: 32 });
  const secondTempleId = stringToHex('temple-02', { size: 32 });
  const unknownTemple = stringToHex('temple-unknown', { size: 32 });
  const token = await deploy('MockUSDC', []);
  const vault = await deploy('DonationVault', [
    token.address, authorizer.address, fee.address,
    [templeId, secondTempleId], [temple.address, temple.address],
  ]);
  const stamp = await deploy('KalashStamp', [minter.address]);
  const cashFeeVault = await deploy('CashFeeVault', [token.address, authorizer.address, fee.address]);
  await success(token, deployer, 'mint', [donor.address, 20_000_000n]);
  await success(token, deployer, 'mint', [outsider.address, 20_000_000n]);
  await success(token, donor, 'approve', [vault.address, maxUint256]);
  await success(token, outsider, 'approve', [vault.address, maxUint256]);
  await success(token, donor, 'approve', [cashFeeVault.address, 2_000_000n]);
  const domain = {
    name: 'KALASH Donation', version: '1', chainId: chain.id, verifyingContract: vault.address,
  };
  const types = {
    Donation: [
      { name: 'donationId', type: 'bytes32' },
      { name: 'donor', type: 'address' },
      { name: 'templeId', type: 'bytes32' },
      { name: 'kind', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  let sequence = 0;
  const deadline = (await publicClient.getBlock()).timestamp + 3600n;
  function intent(overrides = {}) {
    return {
      donationId: stringToHex(`isolated-${++sequence}`, { size: 32 }),
      donor: donor.address, templeId, kind: 0, amount: 10_000n, deadline, ...overrides,
    };
  }
  const sign = (message, signer = authorizer.signer, signedDomain = domain) =>
    signer.signTypedData({ domain: signedDomain, types, primaryType: 'Donation', message });
  await t.test('cash fee binds invoice, temple, payer, exact uncapped amount and consumes once', async () => {
    const message = { invoiceId: stringToHex('cash-fee-invoice', { size: 32 }),
      payer: donor.address, templeId, amount: 1_500_000n, deadline };
    const feeDomain = { name: 'KALASH Cash Fee', version: '1', chainId: chain.id, verifyingContract: cashFeeVault.address };
    const feeTypes = { CashFee: [
      { name: 'invoiceId', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'templeId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] };
    const signature = await authorizer.signer.signTypedData({ domain: feeDomain, types: feeTypes, primaryType: 'CashFee', message });
    const args = [message.invoiceId, templeId, message.amount, deadline, signature];
    const before = await read(token, 'balanceOf', [fee.address]);
    for (const [sender, changed] of [[outsider, args], [donor, [message.invoiceId, secondTempleId, message.amount, deadline, signature]],
      [donor, [message.invoiceId, templeId, message.amount - 1n, deadline, signature]]]) {
      assert.equal((await send(cashFeeVault, sender, 'payFee', changed)).status, 'reverted');
      assert.equal(await read(cashFeeVault, 'consumed', [message.invoiceId]), false);
    }
    const receipt = await success(cashFeeVault, donor, 'payFee', args);
    assert.equal(await read(token, 'balanceOf', [fee.address]), before + message.amount);
    assert.equal(events(receipt, cashFeeVault, 'FeePaid').length, 1);
    assert.equal(await read(cashFeeVault, 'consumed', [message.invoiceId]), true);
    assert.equal((await send(cashFeeVault, donor, 'payFee', args)).status, 'reverted');
    assert.equal(await read(token, 'balanceOf', [fee.address]), before + message.amount);
  });
  const donationArgs = (message, signature) => [
    message.donationId, message.templeId, message.kind, message.amount, message.deadline, signature,
  ];
  async function balances() {
    return Promise.all([donor.address, temple.address, fee.address, vault.address, outsider.address]
      .map((address) => read(token, 'balanceOf', [address])));
  }
  async function rejectedDonation(message, signature, sender = donor) {
    const before = await balances();
    const consumed = await read(vault, 'consumed', [message.donationId]);
    const receipt = await send(vault, sender, 'donate', donationArgs(message, signature));
    assert.equal(receipt.status, 'reverted');
    assert.equal(receipt.logs.length, 0);
    assert.deepEqual(await balances(), before);
    assert.equal(await read(vault, 'consumed', [message.donationId]), consumed);
  }

  await t.test('immutable configuration and six-decimal mock', async () => {
    assert.equal(await read(token, 'decimals'), 6);
    assert.equal((await read(vault, 'token')).toLowerCase(), token.address.toLowerCase());
    assert.equal((await read(vault, 'authorizer')).toLowerCase(), authorizer.address);
    assert.equal((await read(vault, 'feeRecipient')).toLowerCase(), fee.address);
    assert.equal((await read(vault, 'recipients', [templeId])).toLowerCase(), temple.address);
    assert.equal(await read(vault, 'recipients', [unknownTemple]), zeroAddress);
  });
  for (const amount of [1n, 10_000n, 1_000_000n]) {
    await t.test(`donates ${amount} with exact floor fee and direct distribution`, async () => {
      const message = intent({ amount, kind: amount === 1n ? 1 : 0 });
      const before = await balances();
      const receipt = await success(vault, donor, 'donate', donationArgs(message, await sign(message)));
      const expectedFee = amount / 10_000n;
      const after = await balances();
      assert.deepEqual(after, [
        before[0] - amount, before[1] + amount - expectedFee,
        before[2] + expectedFee, 0n, before[4],
      ]);
      assert.equal(await read(vault, 'consumed', [message.donationId]), true);
      const logs = events(receipt, vault, 'Donated');
      assert.equal(logs.length, 1);
      assert.deepEqual(logs[0].args, {
        donationId: message.donationId,
        donor: viem.getAddress(donor.address),
        templeId, kind: message.kind, amount, fee: expectedFee,
        recipient: viem.getAddress(temple.address),
      });
      const transfers = events(receipt, token, 'Transfer');
      assert.equal(transfers.length, expectedFee === 0n ? 1 : 2);
      assert.ok(transfers.every(({ args }) => args.from.toLowerCase() === donor.address));
      await rejectedDonation(message, await sign(message));
    });
  }
  for (const amount of [0n, 1_000_001n]) {
    await t.test(`rejects amount ${amount} before transfers`, async () => {
      const message = intent({ amount });
      await rejectedDonation(message, await sign(message));
    });
  }
  for (const [label, overrides] of [
    ['expired', { deadline: 1n }],
    ['unregistered temple', { templeId: unknownTemple }],
    ['invalid kind', { kind: 2 }],
  ]) {
    await t.test(`rejects ${label}`, async () => {
      const message = intent(overrides);
      await rejectedDonation(message, await sign(message));
    });
  }
  for (const [label, signer, domainOverrides, messageOverrides, sender] of [
    ['wrong signer', outsider.signer, {}, {}, donor],
    ['wrong domain name', authorizer.signer, { name: 'Other Donation' }, {}, donor],
    ['wrong version', authorizer.signer, { version: '2' }, {}, donor],
    ['wrong chain', authorizer.signer, { chainId: 1 }, {}, donor],
    ['wrong vault', authorizer.signer, { verifyingContract: stamp.address }, {}, donor],
    ['wrong donor', authorizer.signer, {}, {}, outsider],
    ['tampered amount', authorizer.signer, {}, { amount: 10_001n }, donor],
    ['tampered temple', authorizer.signer, {}, { templeId: secondTempleId }, donor],
    ['tampered kind', authorizer.signer, {}, { kind: 1 }, donor],
    ['tampered deadline', authorizer.signer, {}, { deadline: deadline + 1n }, donor],
    ['tampered donation ID', authorizer.signer, {}, { donationId: stringToHex('tampered', { size: 32 }) }, donor],
  ]) {
    await t.test(`authorization rejects ${label}`, async () => {
      const message = intent();
      const signature = await sign(message, signer, { ...domain, ...domainOverrides });
      await rejectedDonation({ ...message, ...messageOverrides }, signature, sender);
    });
  }
  await t.test('malformed signature and token failure never consume ID; retry after approval succeeds', async () => {
    const message = intent();
    await rejectedDonation(message, '0x1234');
    await success(token, donor, 'approve', [vault.address, 1n]);
    const signature = await sign(message);
    await rejectedDonation(message, signature);
    await success(token, donor, 'approve', [vault.address, maxUint256]);
    await success(vault, donor, 'donate', donationArgs(message, signature));
    assert.equal(await read(vault, 'consumed', [message.donationId]), true);
  });
  await t.test('stamp minter, deduplication, events, private stable metadata and soulbound restrictions', async () => {
    const donationId = intent().donationId;
    const tokenId = BigInt(donationId);
    const day = 20_762n;
    const args = [donationId, donor.address, templeId, 0, day];
    assert.equal((await read(stamp, 'minter')).toLowerCase(), minter.address);
    assert.equal((await send(stamp, outsider, 'mint', args)).status, 'reverted');
    assert.equal(await read(stamp, 'consumed', [donationId]), false);
    const receipt = await success(stamp, minter, 'mint', args);
    assert.equal(await read(stamp, 'balanceOf', [donor.address, tokenId]), 1n);
    assert.equal(await read(stamp, 'consumed', [donationId]), true);
    assert.deepEqual(events(receipt, stamp, 'StampMinted')[0].args, {
      donationId, recipient: viem.getAddress(donor.address), tokenId, templeId, kind: 0, day,
    });
    const transfer = events(receipt, stamp, 'TransferSingle');
    assert.equal(transfer.length, 1);
    assert.equal(transfer[0].args.from, zeroAddress);
    assert.equal(transfer[0].args.to.toLowerCase(), donor.address);
    assert.equal(transfer[0].args.id, tokenId);
    assert.equal(transfer[0].args.value, 1n);
    assert.equal((await send(stamp, minter, 'mint', args)).status, 'reverted');
    for (const [functionName, callArgs] of [
      ['safeTransferFrom', [donor.address, outsider.address, tokenId, 1n, '0x']],
      ['safeTransferFrom', [donor.address, donor.address, tokenId, 0n, '0x']],
      ['safeBatchTransferFrom', [donor.address, outsider.address, [tokenId], [1n], '0x']],
      ['safeBatchTransferFrom', [donor.address, outsider.address, [], [], '0x']],
      ['setApprovalForAll', [outsider.address, true]],
      ['setApprovalForAll', [outsider.address, false]],
    ]) {
      assert.equal((await send(stamp, donor, functionName, callArgs)).status, 'reverted', functionName);
    }
    assert.equal(await read(stamp, 'isApprovedForAll', [donor.address, outsider.address]), false);
    assert.equal(await read(stamp, 'balanceOf', [donor.address, tokenId]), 1n);
    const uri = await read(stamp, 'uri', [tokenId]);
    assert.ok(uri.startsWith('data:application/json;base64,'));
    const metadata = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    assert.deepEqual(metadata, { templeId, kind: 0, date: Number(day) });
    const secondId = intent().donationId;
    await success(stamp, minter, 'mint', [secondId, outsider.address, templeId, 0, day]);
    assert.equal(await read(stamp, 'uri', [BigInt(secondId)]), uri);
    const onsiteId = intent().donationId;
    await success(stamp, minter, 'mint', [onsiteId, donor.address, templeId, 1, day]);
    assert.equal(await read(stamp, 'balanceOf', [donor.address, BigInt(onsiteId)]), 1n);
    assert.equal(await read(stamp, 'supportsInterface', ['0xd9b67a26']), true);
    assert.equal(await read(stamp, 'supportsInterface', ['0x0e89341c']), true);
    const invalidId = intent().donationId;
    assert.equal((await send(stamp, minter, 'mint', [
      invalidId, donor.address, templeId, 2, day,
    ])).status, 'reverted');
    assert.equal(await read(stamp, 'consumed', [invalidId]), false);
    assert.equal((await send(stamp, minter, 'mint', [
      invalidId, zeroAddress, templeId, 0, day,
    ])).status, 'reverted');
    assert.equal(await read(stamp, 'consumed', [invalidId]), false);
  });
});
