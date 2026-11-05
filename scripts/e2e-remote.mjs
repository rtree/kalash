import { existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  createPublicClient, createWalletClient, erc20Abi, encodeFunctionData, http,
  keccak256, parseAbi, parseEther, toHex, TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';

const origin = process.env.KALASH_TEST_ORIGIN ?? 'http://localhost:3000';
const allowedOrigin = origin === 'http://localhost:3000'
  || origin === 'https://kalash-central-548318651344.asia-south1.run.app';
assert.ok(allowedOrigin, 'Dedicated E2E signer only supports the explicitly named local/Cloud Run KALASH origin.');
const directory = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets');
const wallets = JSON.parse(readFileSync(join(directory, 'wallets.json'), 'utf8'));
const deployed = JSON.parse(readFileSync('config/deployment.public.json', 'utf8'));
const account = privateKeyToAccount(wallets.donor.privateKey);
const transport = http('https://sepolia.base.org', { timeout: 10000, retryCount: 0 });
const chain = createPublicClient({ chain: baseSepolia, transport });
const signer = createWalletClient({ chain: baseSepolia, account, transport });
const progressPath = join(directory, 'donor-e2e-progress.json');
const progress = existsSync(progressPath)
  ? JSON.parse(readFileSync(progressPath, 'utf8'))
  : { chainId: 84532, owner: account.address, origin, reservedGasWei: '0', totalUsdcUnits: '0', donations: [] };
assert.equal(progress.chainId, 84532);
assert.equal(progress.owner, account.address);
function persist() {
  const temporary = `${progressPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
  const file = openSync(temporary, 'r+');
  fsyncSync(file);
  closeSync(file);
  renameSync(temporary, progressPath);
}
let idToken;
async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP${response.status} ${data.error} ${data.message}`);
  return data;
}
const config = await api('/api/config');
assert.equal(config.chainId, 84532);
assert.equal(config.origin, origin);
assert.equal(config.vault.toLowerCase(), deployed.vault.toLowerCase());
assert.equal(config.stamp.toLowerCase(), deployed.stamp.toLowerCase());
assert.equal(config.usdc.toLowerCase(), '0x036cbd53842c5426634e7929541ec2318f3dcf7e');
assert.equal(await chain.getChainId(), 84532);
assert.equal(await chain.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'decimals' }), 6);
const challenge = await api('/api/auth/challenge', { wallet: account.address });
const message = parseSiweMessage(challenge.message);
assert.equal(message.chainId, 84532);
assert.equal(message.domain, new URL(origin).host);
assert.equal(message.uri, origin);
assert.equal(message.nonce, challenge.nonce);
const { customToken } = await api('/api/auth/verify', {
  nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }),
});
const exchange = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.firebase.apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: customToken, returnSecureToken: true }), signal: AbortSignal.timeout(20000),
});
assert.equal(exchange.status, 200);
idToken = (await exchange.json()).idToken;
let item = progress.donations.at(-1);
if (item?.completed && !process.argv.includes('--new-donation')) {
  const saved = await api(`/api/donations/${item.id}`);
  const collection = await api('/api/collection');
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.mintStatus, 'minted');
  assert.equal(collection.donations.filter((entry) => entry.id === item.id && entry.mintStatus === 'minted').length, 1);
  console.log(JSON.stringify({ result: 'existing_real_donation_reload_verified_no_resend', origin, donationId: item.id }));
} else {
  if (!item || item.completed) {
    assert.ok(progress.donations.length < 20 && BigInt(progress.totalUsdcUnits) + 10000n <= 200000n, 'Dedicated donor cumulative budget exhausted');
    const priorCollection = await api('/api/collection');
    const donation = await api('/api/donations', { templeId: 'temple-01', amount: '0.01' });
    assert.equal(donation.amount, '10000');
    assert.equal(donation.fee, '1');
    assert.equal(donation.net, '9999');
    assert.equal(donation.recipient.toLowerCase(), wallets['temple-01'].address.toLowerCase());
    assert.equal(donation.ownerWallet.toLowerCase(), account.address.toLowerCase());
    assert.equal(donation.kind, 0);
    item = {
      id: donation.id, intent: donation, operations: {},
      priorPointUnits: priorCollection.points['temple-01'] ?? '0', startedAt: new Date().toISOString(),
    };
    progress.donations.push(item);
    progress.totalUsdcUnits = (BigInt(progress.totalUsdcUnits) + 10000n).toString();
    persist();
  }
  async function send(operation, target, data) {
    let state = item.operations[operation];
    if (!state) {
      state = { attemptId: crypto.randomUUID() };
      item.operations[operation] = state;
      persist();
    }
    if (!state.rawTransaction) {
      const registered = await api(`/api/donations/${item.id}/operation`, { operation, attemptId: state.attemptId });
      assert.equal(registered.id, item.id);
      const gas = await chain.estimateGas({ account, to: target, data }) * 12n / 10n;
      const fees = await chain.estimateFeesPerGas();
      const reserve = gas * fees.maxFeePerGas * 2n + 1000000000000n;
      assert.ok(BigInt(progress.reservedGasWei) + reserve <= parseEther('0.003'), 'Dedicated donor gas budget exhausted');
      const nonce = await chain.getTransactionCount({ address: account.address, blockTag: 'pending' });
      state.rawTransaction = await account.signTransaction({ type: 'eip1559', chainId: 84532, to: target, data, nonce, gas, ...fees });
      state.hash = keccak256(state.rawTransaction);
      state.startedAt = new Date().toISOString();
      progress.reservedGasWei = (BigInt(progress.reservedGasWei) + reserve).toString();
      persist();
    }
    let receipt;
    try { receipt = await chain.getTransactionReceipt({ hash: state.hash }); } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    if (!receipt) {
      // Reusing persisted signed bytes is safe; never build a replacement payment.
      try { await signer.sendRawTransaction({ serializedTransaction: state.rawTransaction }); } catch (error) {
        console.error(JSON.stringify({ operation, donationId: item.id, hash: state.hash, outcome: 'unknown', error: error.name }));
      }
      receipt = await chain.waitForTransactionReceipt({ hash: state.hash, timeout: 90000 });
    }
    assert.equal(receipt.status, 'success', `${operation} reverted; do not recreate the donation`);
    state.receiptAt = new Date().toISOString();
    state.blockNumber = receipt.blockNumber.toString();
    persist();
    return state.hash;
  }
  const d = item.intent;
  const amount = BigInt(d.amount);
  assert.ok(amount > 0n && amount <= 10000n);
  assert.equal(d.templeKey, keccak256(toHex('temple-01')));
  const allowance = await chain.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, config.vault] });
  if (allowance < amount) {
    await send('approve', config.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [config.vault, amount] }));
  }
  const vaultAbi = parseAbi(['function donate(bytes32,bytes32,uint8,uint256,uint256,bytes)']);
  const hash = await send('donate', config.vault, encodeFunctionData({
    abi: vaultAbi, functionName: 'donate', args: [d.id, d.templeKey, 0, amount, BigInt(d.deadline), d.signature],
  }));
  const first = await api(`/api/donations/${item.id}/verify`, {});
  assert.equal(first.status, 'confirmed');
  item.confirmedAt = new Date().toISOString();
  persist();
  const deadline = Date.now() + 120000;
  let final = first;
  while (Date.now() < deadline && final.mintStatus !== 'minted') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    final = await api(`/api/donations/${item.id}`);
  }
  assert.equal(final.mintStatus, 'minted', 'Real mint did not complete; inspect durable job, do not resend donation');
  // Two concurrent hints and a no-hash recovery must not add points or mint again.
  await Promise.all([
    api(`/api/donations/${item.id}/verify`, { txHash: hash }),
    api(`/api/donations/${item.id}/verify`, {}),
  ]);
  const reloaded = await api('/api/collection');
  assert.equal(reloaded.donations.filter((entry) => entry.id === item.id && entry.mintStatus === 'minted').length, 1);
  assert.equal(BigInt(reloaded.points['temple-01']), BigInt(item.priorPointUnits) + 10000n);
  item.completed = true;
  item.mintTxHash = final.mintTxHash;
  item.tokenId = final.tokenId;
  item.mintedAt = new Date().toISOString();
  persist();
  console.log(JSON.stringify({
    result: 'real_api_chain_mint_collection_passed', donationId: item.id,
    donationTxHash: hash, mintTxHash: final.mintTxHash, tokenId: final.tokenId,
    amount: d.amount, fee: d.fee, net: d.net, pointUnits: reloaded.points['temple-01'],
    startedAt: item.startedAt, confirmedAt: item.confirmedAt, mintedAt: item.mintedAt,
    limitation: 'Dedicated test-process signer; not yet normal MetaMask browser evidence.',
  }, null, 2));
}
