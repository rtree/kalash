import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData,
  erc20Abi, http, keccak256, parseAbi, parseEther, TransactionReceiptNotFoundError,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';

const ORIGIN = 'https://kalash-central-548318651344.asia-south1.run.app';
const CHAIN_ID = 84532;
const DONATION_UNITS = 10000n;
const MAX_TX_GAS = { approve: 200000n, donate: 400000n };
const donateAbi = parseAbi([
  'function donate(bytes32 donationId,bytes32 templeId,uint8 kind,uint256 amount,uint256 deadline,bytes signature)',
]);
const accounts = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'KALASH', 'secrets', 'wallets.json'), 'utf8'));
const deployed = JSON.parse(readFileSync('config/deployment.public.json', 'utf8'));
const publicWallets = JSON.parse(readFileSync('config/wallets.public.json', 'utf8'));
const secretDirectory = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets');
const progressPath = join(secretDirectory, 'donor-e2e-progress.json');
const lockPath = `${progressPath}.browser.lock`;
const profilePath = join(secretDirectory, 'browser-e2e-profile');
const evidenceDirectory = join(process.env.LOCALAPPDATA, 'KALASH', 'browser-e2e-evidence');
const runId = randomUUID();
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const donor = privateKeyToAccount(accounts.donor.privateKey);
const transport = http('https://sepolia.base.org', { timeout: 15000, retryCount: 0 });
const chain = createPublicClient({ chain: baseSepolia, transport });
const signer = createWalletClient({ chain: baseSepolia, account: donor, transport });

assert.equal(ORIGIN, 'https://kalash-central-548318651344.asia-south1.run.app');
assert.equal(await chain.getChainId(), CHAIN_ID, 'The test signer only runs on Base Sepolia.');
assert.equal(donor.address.toLowerCase(), publicWallets.wallets.donor.toLowerCase());
assert.equal(existsSync(profilePath), false, 'Refusing to reuse a browser profile.');
assert.equal(existsSync(lockPath), false, 'A donor E2E progress lock already exists.');

const lock = openSync(lockPath, 'wx', 0o600);
process.on('exit', () => {
  try { closeSync(lock); } catch {}
  try { rmSync(lockPath, { force: true }); } catch {}
  try { rmSync(profilePath, { recursive: true, force: true }); } catch {}
});
const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
assert.equal(progress.chainId, CHAIN_ID);
assert.equal(progress.owner.toLowerCase(), donor.address.toLowerCase());
assert.ok(progress.donations.length < publicWallets.budgets.donor.maxTransactions);
assert.ok(BigInt(progress.reservedGasWei) <= parseEther('0.003'));
const lastProgressItem = progress.donations.at(-1);
const resumableItem = lastProgressItem && !lastProgressItem.completed
  && lastProgressItem.origin === ORIGIN
  && lastProgressItem.status === 'intent'
  && lastProgressItem.intent?.templeId === 'temple-01'
  && lastProgressItem.intent?.amount === DONATION_UNITS.toString()
  && Object.keys(lastProgressItem.operations ?? {}).length === 0
  && BigInt(lastProgressItem.intent.deadline) > BigInt(Math.floor(Date.now() / 1000))
  ? lastProgressItem
  : null;
assert.ok(lastProgressItem?.completed || resumableItem, 'An unresolved donation already exists; refusing to create another.');
assert.ok(BigInt(progress.totalUsdcUnits) + (resumableItem ? 0n : DONATION_UNITS) <= 200000n);
if (resumableItem) {
  assert.equal(resumableItem.intent.kind, 0);
  assert.equal(resumableItem.intent.fee, '1');
  assert.equal(resumableItem.intent.net, '9999');
  assert.equal(normalizedAddress(resumableItem.intent.ownerWallet, 'resumed donation owner'), donor.address.toLowerCase());
  assert.equal(normalizedAddress(resumableItem.intent.recipient, 'resumed temple recipient'), publicWallets.wallets['temple-01'].toLowerCase());
  assert.equal(resumableItem.intent.templeKey, keccak256(toHex('temple-01')));
  assert.match(resumableItem.intent.signatureDigest, /^[0-9a-f]{64}$/i);
}
const existingOperationCount = progress.donations
  .flatMap((item) => Object.values(item.operations ?? {}))
  .filter((operation) => operation.hash).length;
assert.ok(existingOperationCount < publicWallets.budgets.donor.maxTransactions);

function persist() {
  const temporary = `${progressPath}.browser-${runId}.tmp`;
  let file = null;
  try {
    writeFileSync(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
    file = openSync(temporary, 'r+');
    fsyncSync(file);
    closeSync(file);
    file = null;
    renameSync(temporary, progressPath);
  } finally {
    if (file !== null) closeSync(file);
    rmSync(temporary, { force: true });
  }
}

function fail(message) {
  throw new Error(message);
}

function bigintField(value, label) {
  try {
    if (typeof value === 'string' && !value.startsWith('0x') && !/^\d+$/.test(value)) fail(`Invalid ${label}.`);
    return BigInt(value);
  } catch {
    return fail(`Invalid ${label}.`);
  }
}

function normalizedAddress(value, label) {
  assert.equal(typeof value, 'string', `Missing ${label}.`);
  assert.match(value, /^0x[0-9a-fA-F]{40}$/, `Invalid ${label}.`);
  return value.toLowerCase();
}

function digestSignature(signature) {
  assert.match(signature, /^0x(?:[0-9a-fA-F]{2})+$/, 'Invalid intent signature bytes.');
  return createHash('sha256').update(Buffer.from(signature.slice(2), 'hex')).digest('hex');
}

const publicConfigResponse = await fetch(`${ORIGIN}/api/config`, {
  headers: { Origin: ORIGIN, Accept: 'application/json' },
  signal: AbortSignal.timeout(20000),
});
assert.equal(publicConfigResponse.status, 200);
const config = await publicConfigResponse.json();
assert.equal(config.origin, ORIGIN);
assert.equal(config.chainId, CHAIN_ID);
assert.equal(config.vault.toLowerCase(), deployed.vault.toLowerCase());
assert.equal(config.stamp.toLowerCase(), deployed.stamp.toLowerCase());
assert.equal(config.usdc.toLowerCase(), '0x036cbd53842c5426634e7929541ec2318f3dcf7e');
assert.equal(await chain.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'decimals' }), 6);
const expectedApprovalRequired = await chain.readContract({
  address: config.usdc,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [donor.address, config.vault],
}) < DONATION_UNITS;

const indexResponse = await fetch(ORIGIN, { signal: AbortSignal.timeout(15000) });
assert.equal(indexResponse.status, 200);
const html = await indexResponse.text();
const appScriptPath = /<script[^>]+src="([^"]*app\.js)"[^>]*>/i.exec(html)?.[1];
assert.ok(appScriptPath, 'Canonical UI entry script not found.');
const appScriptResponse = await fetch(new URL(appScriptPath, ORIGIN), { signal: AbortSignal.timeout(20000) });
assert.equal(appScriptResponse.status, 200);
const appScriptHash = createHash('sha256').update(Buffer.from(await appScriptResponse.arrayBuffer())).digest('hex');
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const chromeVersion = spawnSync(chromePath, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();

let item = resumableItem;
let expectedIntent = resumableItem?.intent ?? null;
let priorCollection = resumableItem ? {
  pointUnits: resumableItem.priorPointUnits,
  remoteStampCount: resumableItem.priorRemoteStampCount,
} : null;
let latestCollection = null;
let latestHistory = null;
let latestDonation = null;
let accountAuthorized = false;
let browserProcess = null;
let browserSocket = null;
let browserPid = null;
let remotePort = null;
let cdpId = 0;
let cdpPending = new Map();
let rpcPending = new Map();
let executionOrigins = new Map();
let operationQueue = Promise.resolve();
let receiverError = null;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined) {
        const pending = cdpPending.get(message.id);
        if (!pending) return;
        cdpPending.delete(message.id);
        if (message.error) pending.reject(new Error(`CDP command failed: ${message.error.code}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context;
        if (context?.id !== undefined) executionOrigins.set(context.id, context.origin);
      } else if (message.method === 'Runtime.executionContextDestroyed') {
        executionOrigins.delete(message.params?.executionContextId);
      } else if (message.method === 'Runtime.bindingCalled') {
        operationQueue = operationQueue.then(() => this.onBinding(message)).catch((error) => {
          receiverError = error;
          this.replyBinding(message.params.executionContextId, message.params.payload, false, 'Test harness rejected this action safely.');
        });
      }
    });
  }

  send(method, params = {}) {
    const id = ++cdpId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cdpPending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      cdpPending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
    return result.result?.value;
  }

  replyBinding(executionContextId, payload, ok, value) {
    let binding;
    try { binding = JSON.parse(payload); } catch { return; }
    if (!Number.isSafeInteger(binding.bridgeId)) return;
    const expression = `globalThis.__kalashE2EResolve(${JSON.stringify({
      bridgeId: binding.bridgeId,
      ok,
      value,
    })})`;
    void this.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async onBinding(event) {
    const { executionContextId, payload } = event.params;
    if (executionOrigins.get(executionContextId) !== ORIGIN) {
      this.replyBinding(executionContextId, payload, false, 'Test signer is restricted to the canonical KALASH origin.');
      return;
    }
    const message = JSON.parse(payload);
    if (!Number.isSafeInteger(message.bridgeId) || typeof message.kind !== 'string') return;
    try {
      let result;
      switch (message.kind) {
        case 'provider-request':
          result = await this.handleProviderRequest(message);
          break;
        case 'intent':
          result = this.handleIntent(message);
          break;
        case 'operation-start':
          result = this.handleOperationStart(message);
          break;
        case 'operation-result':
          result = this.handleOperationResult(message);
          break;
        case 'donation-state':
          result = this.handleDonationState(message);
          break;
        case 'collection':
          result = this.handleCollection(message);
          break;
        case 'history':
          result = this.handleHistory(message);
          break;
        default:
          fail('Unexpected browser test bridge message.');
      }
      this.replyBinding(executionContextId, payload, true, result ?? null);
    } catch (error) {
      this.replyBinding(executionContextId, payload, false, 'The isolated test signer rejected this request.');
      if (message.kind !== 'provider-request') receiverError = error;
    }
  }

  handleIntent(message) {
    assert.ok(!item || item.completed, 'A browser attempt tried to create a second unresolved donation.');
    assert.equal(message.requestedTempleId, 'temple-01');
    assert.equal(message.requestedAmount, '0.01');
    const donation = message.intent;
    assert.equal(donation.templeId, 'temple-01');
    assert.equal(donation.kind, 0);
    assert.equal(donation.amount, '10000');
    assert.equal(donation.fee, '1');
    assert.equal(donation.net, '9999');
    assert.equal(normalizedAddress(donation.ownerWallet, 'donation owner'), donor.address.toLowerCase());
    assert.equal(normalizedAddress(donation.recipient, 'temple recipient'), publicWallets.wallets['temple-01'].toLowerCase());
    assert.equal(donation.templeKey, keccak256(toHex('temple-01')));
    assert.equal(typeof donation.id, 'string');
    assert.equal(typeof donation.signatureDigest, 'string');
    assert.match(donation.id, /^0x[0-9a-f]{64}$/i);
    assert.match(donation.signatureDigest, /^[0-9a-f]{64}$/i);
    assert.ok(progress.donations.length < publicWallets.budgets.donor.maxTransactions);
    assert.ok(BigInt(progress.totalUsdcUnits) + DONATION_UNITS <= 200000n);
    assert.ok(existingOperationCount < publicWallets.budgets.donor.maxTransactions);
    const priorPointUnits = priorCollection?.pointUnits ?? '0';
    item = {
      id: donation.id,
      origin: ORIGIN,
      intent: {
        id: donation.id,
        templeId: donation.templeId,
        templeKey: donation.templeKey,
        kind: donation.kind,
        amount: donation.amount,
        fee: donation.fee,
        net: donation.net,
        recipient: donation.recipient,
        ownerWallet: donation.ownerWallet,
        deadline: donation.deadline,
        signatureDigest: donation.signatureDigest,
      },
      operations: {},
      priorPointUnits,
      priorRemoteStampCount: priorCollection?.remoteStampCount ?? 0,
      startedAt: new Date().toISOString(),
    };
    progress.donations.push(item);
    progress.totalUsdcUnits = (BigInt(progress.totalUsdcUnits) + DONATION_UNITS).toString();
    persist();
    expectedIntent = item.intent;
    return { donationId: item.id };
  }

  handleOperationStart(message) {
    assert.ok(item && !item.completed, 'No active browser donation.');
    assert.equal(message.donationId, item.id);
    assert.ok(message.operation === 'approve' || message.operation === 'donate');
    assert.match(message.attemptId, /^[0-9a-f-]{36}$/i);
    const previous = item.operations[message.operation];
    if (previous) {
      assert.equal(previous.attemptId, message.attemptId, 'Refusing a new attempt for an existing wallet operation.');
      assert.ok(!previous.hash || previous.requestFingerprint, 'Existing transaction state is incomplete; refusing a replacement.');
    } else {
      item.operations[message.operation] = {
        attemptId: message.attemptId,
        registered: false,
      };
      persist();
    }
    return null;
  }

  handleOperationResult(message) {
    assert.ok(item && item.id === message.donationId);
    assert.ok(message.operation === 'approve' || message.operation === 'donate');
    const state = item.operations[message.operation];
    assert.ok(state && state.attemptId === message.attemptId);
    if (!message.ok) {
      state.registrationFailed = true;
      persist();
      return null;
    }
    state.registered = true;
    persist();
    return null;
  }

  handleDonationState(message) {
    if (!item || message.donationId !== item.id) return null;
    latestDonation = message.donation;
    item.status = message.donation.status;
    item.mintStatus = message.donation.mintStatus ?? null;
    item.donationTxHash = message.donation.txHash ?? item.operations.donate?.hash ?? null;
    item.mintTxHash = message.donation.mintTxHash ?? null;
    item.tokenId = message.donation.tokenId ?? null;
    if (message.donation.status === 'confirmed' && !item.confirmedAt) item.confirmedAt = new Date().toISOString();
    if (message.donation.mintStatus === 'minted' && !item.mintedAt) item.mintedAt = new Date().toISOString();
    persist();
    return null;
  }

  handleCollection(message) {
    const collection = message.collection;
    const snapshot = {
      at: new Date().toISOString(),
      pointUnits: String(collection.points?.['temple-01'] ?? '0'),
      remoteStampCount: collection.donations.filter((donation) =>
        donation.templeId === 'temple-01' && donation.kind === 0 && donation.mintStatus === 'minted').length,
      currentDonationMinted: item
        ? collection.donations.some((donation) => donation.id === item.id && donation.mintStatus === 'minted')
        : false,
      currentDonationTxHash: item
        ? collection.donations.find((donation) => donation.id === item.id)?.txHash ?? null
        : null,
      currentDonationMintTxHash: item
        ? collection.donations.find((donation) => donation.id === item.id)?.mintTxHash ?? null
        : null,
      currentDonationTokenId: item
        ? collection.donations.find((donation) => donation.id === item.id)?.tokenId ?? null
        : null,
    };
    if (!item) priorCollection = snapshot;
    latestCollection = snapshot;
    if (item) {
      item.collectionReload = snapshot;
      persist();
    }
    return null;
  }

  handleHistory(message) {
    const matches = message.donations.filter((donation) => donation.id === item?.id);
    latestHistory = {
      at: new Date().toISOString(),
      currentDonationCount: matches.length,
      donation: matches[0] ?? null,
    };
    if (item) {
      item.historyReload = latestHistory;
      persist();
    }
    return null;
  }

  async handleProviderRequest(message) {
    const { method, params = [] } = message;
    if (method === 'eth_accounts') return accountAuthorized ? [donor.address] : [];
    if (method === 'eth_requestAccounts') {
      accountAuthorized = true;
      return [donor.address];
    }
    if (method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
    if (method === 'net_version') return String(CHAIN_ID);
    if (method === 'eth_coinbase') return accountAuthorized ? donor.address : null;
    if (method === 'wallet_switchEthereumChain') {
      const requested = params?.[0]?.chainId;
      assert.equal(BigInt(requested), BigInt(CHAIN_ID), 'The isolated wallet cannot switch away from Base Sepolia.');
      return null;
    }
    if (method === 'personal_sign') {
      assert.ok(accountAuthorized, 'Wallet account has not been granted to the page.');
      assert.ok(Array.isArray(params) && params.length >= 2);
      const [first, second] = params;
      const message = typeof first === 'string' && first.toLowerCase() === donor.address.toLowerCase() ? second : first;
      const suppliedAddress = typeof first === 'string' && first.toLowerCase() === donor.address.toLowerCase() ? first : second;
      assert.equal(normalizedAddress(suppliedAddress, 'signing account'), donor.address.toLowerCase());
      assert.equal(typeof message, 'string');
      const siweText = message.startsWith('0x')
        ? Buffer.from(message.slice(2), 'hex').toString('utf8')
        : message;
      const siwe = parseSiweMessage(siweText);
      assert.equal(siwe.address?.toLowerCase(), donor.address.toLowerCase());
      assert.equal(siwe.chainId, CHAIN_ID);
      assert.equal(siwe.domain, new URL(ORIGIN).host);
      assert.equal(siwe.uri, ORIGIN);
      assert.ok(siwe.nonce);
      return donor.signMessage({ message: siweText });
    }
    if (method === 'eth_sendTransaction') {
      assert.ok(accountAuthorized, 'Wallet account has not been granted to the page.');
      assert.ok(Array.isArray(params) && params.length === 1);
      return this.sendUiTransaction(params[0]);
    }
    if (method === 'eth_estimateGas') {
      assert.ok(Array.isArray(params) && params.length === 1);
      const transaction = params[0];
      const operation = this.validateUiTransaction(transaction);
      return this.estimateUiGas(transaction, operation);
    }
    const readOnlyMethods = new Set([
      'eth_blockNumber', 'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber',
      'eth_getCode', 'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash',
      'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_call', 'eth_feeHistory',
      'eth_gasPrice', 'eth_maxPriorityFeePerGas',
    ]);
    if (readOnlyMethods.has(method)) {
      return chain.request({ method, params });
    }
    if (method === 'web3_clientVersion') return 'KALASH isolated test connector';
    throw new Error('Unsupported test-provider request.');
  }

  validateUiTransaction(transaction) {
    assert.ok(item && expectedIntent && !item.completed, 'No active authorized donation intent.');
    const from = normalizedAddress(transaction?.from, 'transaction sender');
    assert.equal(from, donor.address.toLowerCase(), 'Transaction sender must be the dedicated donor.');
    if (transaction.chainId !== undefined) assert.equal(bigintField(transaction.chainId, 'transaction chain'), BigInt(CHAIN_ID));
    if (transaction.value !== undefined) assert.equal(bigintField(transaction.value, 'transaction value'), 0n);
    const to = normalizedAddress(transaction?.to, 'transaction destination');
    assert.match(transaction?.data ?? '', /^0x[0-9a-fA-F]+$/, 'Missing transaction calldata.');
    if (to === config.usdc.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
      assert.equal(decoded.functionName, 'approve');
      const [spender, value] = decoded.args;
      assert.equal(normalizedAddress(spender, 'approval spender'), config.vault.toLowerCase());
      assert.equal(BigInt(value), DONATION_UNITS);
      return 'approve';
    }
    assert.equal(to, config.vault.toLowerCase(), 'Transaction target must be the registered vault.');
    const decoded = decodeFunctionData({ abi: donateAbi, data: transaction.data });
    assert.equal(decoded.functionName, 'donate');
    const [donationId, templeKey, kind, amount, deadline, signature] = decoded.args;
    assert.equal(donationId.toLowerCase(), expectedIntent.id.toLowerCase());
    assert.equal(templeKey.toLowerCase(), expectedIntent.templeKey.toLowerCase());
    assert.equal(kind, 0);
    assert.equal(BigInt(amount), DONATION_UNITS);
    assert.equal(BigInt(deadline), BigInt(expectedIntent.deadline));
    assert.equal(digestSignature(signature), expectedIntent.signatureDigest);
    return 'donate';
  }

  async estimateUiGas(transaction, operation) {
    const state = item.operations[operation];
    assert.ok(state?.registered && !state.registrationFailed, 'The Central operation was not authorized.');
    const encoded = encodeFunctionData({
      abi: operation === 'approve' ? erc20Abi : donateAbi,
      functionName: operation === 'approve' ? 'approve' : 'donate',
      args: operation === 'approve'
        ? [config.vault, DONATION_UNITS]
        : [
          expectedIntent.id,
          expectedIntent.templeKey,
          0,
          DONATION_UNITS,
          BigInt(expectedIntent.deadline),
          '0x',
        ],
    });
    const estimateData = operation === 'donate' ? transaction.data : encoded;
    const gas = await chain.estimateGas({
      account: donor,
      to: operation === 'approve' ? config.usdc : config.vault,
      data: estimateData,
      value: 0n,
    });
    assert.ok(gas <= MAX_TX_GAS[operation], 'Gas estimate exceeds the per-operation safety cap.');
    return `0x${gas.toString(16)}`;
  }

  async sendUiTransaction(transaction) {
    const operation = this.validateUiTransaction(transaction);
    const state = item.operations[operation];
    assert.ok(state?.registered && !state.registrationFailed, 'The Central operation was not authorized.');
    const fingerprint = createHash('sha256')
      .update(`${normalizedAddress(transaction.to, 'transaction target')}:${transaction.data.toLowerCase()}`)
      .digest('hex');
    if (state.rawTransaction) {
      assert.equal(state.requestFingerprint, fingerprint, 'Refusing to replace an already-signed transaction.');
      assert.ok(state.hash, 'Existing signed transaction hash is missing.');
      let receipt;
      try { receipt = await chain.getTransactionReceipt({ hash: state.hash }); } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
      if (receipt) {
        assert.equal(receipt.status, 'success', 'Existing transaction reverted; refusing a replacement.');
        return state.hash;
      }
      if (state.broadcastAttemptedAt) fail('Transaction outcome is unknown; refusing to rebroadcast automatically.');
    }
    assert.ok(!state.rawTransaction && !state.broadcastAttemptedAt, 'Refusing a second signing or transaction attempt.');
    const sentCount = progress.donations
      .flatMap((donation) => Object.values(donation.operations ?? {}))
      .filter((entry) => entry.hash).length;
    assert.ok(sentCount < publicWallets.budgets.donor.maxTransactions, 'Dedicated donor transaction-count budget exhausted.');
    const gasEstimate = await chain.estimateGas({
      account: donor,
      to: transaction.to,
      data: transaction.data,
      value: 0n,
    });
    assert.ok(gasEstimate <= MAX_TX_GAS[operation], 'Gas estimate exceeds the per-operation safety cap.');
    const gas = gasEstimate * 12n / 10n;
    assert.ok(gas <= MAX_TX_GAS[operation], 'Buffered gas exceeds the per-operation safety cap.');
    const fees = await chain.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? await chain.getGasPrice();
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
    const reserve = gas * maxFeePerGas * 2n + 1000000000000n;
    assert.ok(BigInt(progress.reservedGasWei) + reserve <= parseEther('0.003'), 'Dedicated donor gas budget exhausted.');
    assert.ok(await chain.getBalance({ address: donor.address }) >= gas * maxFeePerGas, 'Dedicated donor has insufficient test gas.');
    const nonce = await chain.getTransactionCount({ address: donor.address, blockTag: 'pending' });
    const signed = await donor.signTransaction({
      type: 'eip1559',
      chainId: CHAIN_ID,
      to: transaction.to,
      data: transaction.data,
      value: 0n,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    state.rawTransaction = signed;
    state.hash = keccak256(signed);
    state.requestFingerprint = fingerprint;
    state.amountUnits = DONATION_UNITS.toString();
    state.gasReserveWei = reserve.toString();
    state.startedAt = new Date().toISOString();
    progress.reservedGasWei = (BigInt(progress.reservedGasWei) + reserve).toString();
    persist();
    state.broadcastAttemptedAt = new Date().toISOString();
    persist();

    try {
      await signer.sendRawTransaction({ serializedTransaction: state.rawTransaction });
      state.broadcastAcceptedAt = new Date().toISOString();
      persist();
    } catch (error) {
      state.broadcastErrorName = error?.name ?? 'UnknownError';
      persist();
      throw new Error('Transaction submission outcome is unknown; no retry will be attempted.');
    }
    void this.recordReceipt(operation, state);
    return state.hash;
  }

  async recordReceipt(operation, state) {
    try {
      const receipt = await chain.waitForTransactionReceipt({ hash: state.hash, confirmations: 1, timeout: 120000 });
      state.receiptStatus = receipt.status;
      state.receiptAt = new Date().toISOString();
      state.blockNumber = receipt.blockNumber.toString();
      persist();
      if (receipt.status !== 'success') receiverError = new Error(`${operation} transaction reverted; no retry is permitted.`);
    } catch (error) {
      state.receiptErrorName = error?.name ?? 'UnknownError';
      persist();
      receiverError = new Error(`${operation} receipt is unresolved; no retry is permitted.`);
    }
  }
}

const bridgeSource = `(() => {
  const origin = ${JSON.stringify(ORIGIN)};
  if (location.origin !== origin || typeof globalThis.__kalashBrowserBinding !== 'function') return;
  ${resumableItem ? `localStorage.setItem('kalash:currentDonationId', ${JSON.stringify(resumableItem.id)});` : ''}
  let bridgeSequence = 0;
  const bridgePending = new Map();
  let providerAuthorized = false;
  const bridge = (kind, fields = {}) => new Promise((resolve, reject) => {
    const bridgeId = ++bridgeSequence;
    bridgePending.set(bridgeId, { resolve, reject });
    globalThis.__kalashBrowserBinding(JSON.stringify({ bridgeId, kind, ...fields }));
  });
  globalThis.__kalashE2EResolve = ({ bridgeId, ok, value }) => {
    const pending = bridgePending.get(bridgeId);
    if (!pending) return;
    bridgePending.delete(bridgeId);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(typeof value === 'string' ? value : 'Test harness rejected this action.'));
  };
  const listeners = new Map();
  const emit = (event, value) => (listeners.get(event) || []).forEach((listener) => {
    try { listener(value); } catch {}
  });
  const provider = {
    isMetaMask: false,
    isConnected: () => true,
    request: async ({ method, params = [] }) => {
      const result = await bridge('provider-request', { method, params });
      if (method === 'eth_requestAccounts') {
        providerAuthorized = true;
        emit('connect', { chainId: '0x14a34' });
        emit('accountsChanged', result);
      }
      return result;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return this;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    once(event, listener) {
      const wrapped = (...args) => { this.removeListener(event, wrapped); listener(...args); };
      return this.on(event, wrapped);
    },
    get chainId() { return '0x14a34'; },
    get networkVersion() { return '84532'; },
    get selectedAddress() { return providerAuthorized ? ${JSON.stringify(donor.address)} : null; },
  };
  Object.defineProperty(window, 'ethereum', { configurable: true, enumerable: true, value: provider });
  const publish = async (path, method, requestBody, response) => {
    try {
      if (path === '/api/donations' && method === 'POST' && response.ok) {
        const intent = await response.clone().json();
        const body = JSON.parse(requestBody || '{}');
        const signatureBytes = new Uint8Array((intent.signature.match(/[0-9a-fA-F]{2}/g) || []).map((byte) => Number.parseInt(byte, 16)).slice(1));
        const signatureDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', signatureBytes)))
          .map((byte) => byte.toString(16).padStart(2, '0')).join('');
        await bridge('intent', {
          requestedTempleId: body.templeId,
          requestedAmount: body.amount,
          intent: {
            id: intent.id,
            templeId: intent.templeId,
            templeKey: intent.templeKey,
            kind: intent.kind,
            amount: intent.amount,
            fee: intent.fee,
            net: intent.net,
            recipient: intent.recipient,
            ownerWallet: intent.ownerWallet,
            deadline: intent.deadline,
            signatureDigest,
          },
        });
      } else {
        const operation = /^\\/api\\/donations\\/(0x[0-9a-fA-F]{64})\\/operation$/.exec(path);
        if (operation && method === 'POST') {
          const body = JSON.parse(requestBody || '{}');
          await bridge('operation-result', {
            donationId: operation[1],
            operation: body.operation,
            attemptId: body.attemptId,
            ok: response.ok,
          });
        } else if (/^\\/api\\/donations\\/0x[0-9a-fA-F]{64}(?:\\/verify)?$/.test(path) && response.ok) {
          const donation = await response.clone().json();
          await bridge('donation-state', {
            donationId: donation.id,
            donation: {
              id: donation.id,
              templeId: donation.templeId,
              kind: donation.kind,
              amount: donation.amount,
              fee: donation.fee,
              net: donation.net,
              status: donation.status,
              mintStatus: donation.mintStatus,
              txHash: donation.txHash,
              mintTxHash: donation.mintTxHash,
              tokenId: donation.tokenId,
            },
          });
        } else if (path === '/api/collection' && method === 'GET' && response.ok) {
          const collection = await response.clone().json();
          await bridge('collection', {
            collection: {
              points: { 'temple-01': collection.points?.['temple-01'] ?? '0' },
              donations: (collection.donations || []).map((donation) => ({
                id: donation.id,
                templeId: donation.templeId,
                kind: donation.kind,
                status: donation.status,
                mintStatus: donation.mintStatus,
                txHash: donation.txHash,
                mintTxHash: donation.mintTxHash,
                tokenId: donation.tokenId,
              })),
            },
          });
        } else if (path === '/api/history' && method === 'GET' && response.ok) {
          const history = await response.clone().json();
          await bridge('history', {
            donations: (history.donations || []).map((donation) => ({
              id: donation.id,
              templeId: donation.templeId,
              kind: donation.kind,
              amount: donation.amount,
              status: donation.status,
              mintStatus: donation.mintStatus,
              txHash: donation.txHash,
            })),
          });
        }
      }
    } catch {
      throw new Error('Browser test bridge rejected a response.');
    }
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (requestUrl.origin !== origin) return originalFetch(input, init);
    const method = String(init.method || (typeof input === 'string' ? 'GET' : input.method || 'GET')).toUpperCase();
    const path = requestUrl.pathname;
    let requestBody = init.body ? String(init.body) : '';
    if (!requestBody && method !== 'GET' && typeof input !== 'string') {
      try { requestBody = await input.clone().text(); } catch {}
    }
    const operation = /^\\/api\\/donations\\/(0x[0-9a-fA-F]{64})\\/operation$/.exec(path);
    if (operation && method === 'POST') {
      const body = JSON.parse(requestBody || '{}');
      await bridge('operation-start', {
        donationId: operation[1],
        operation: body.operation,
        attemptId: body.attemptId,
      });
    }
    const response = await originalFetch(input, init);
    if (path === '/api/donations' || path === '/api/collection' || path === '/api/history'
        || /^\\/api\\/donations\\/(?:0x[0-9a-fA-F]{64})(?:\\/operation|\\/verify)?$/.test(path)) {
      await publish(path, method, requestBody, response);
    }
    return response;
  };
})();`;

let page = null;
async function safeUiDiagnostics() {
  if (!page) return null;
  try {
    return await page.evaluate(`(() => ({
      path: location.pathname,
      notices: [...document.querySelectorAll('.notice')].map((element) => ({
        role: element.getAttribute('role'),
        text: (element.querySelector('span')?.innerText || '').slice(0, 240),
      })),
      walletTrace: (window.__KALASH_WALLET_TRACE__ || []).slice(-10),
    }))()`);
  } catch {
    return null;
  }
}

async function waitForFile(path, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not open its isolated debugging endpoint.');
}

async function waitForPage(test, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (receiverError) throw receiverError;
    const result = await page.evaluate(typeof test === 'string' ? test : `(${test.toString()})()`);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for the browser UI.');
}

async function clickButton(text, { within = '' } = {}) {
  const expression = `(() => {
    const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'};
    if (!root) return { missingRoot: ${JSON.stringify(within)}, path: location.pathname, navCount: document.querySelectorAll('nav').length };
    const label = (item) => {
      const copy = item.cloneNode(true);
      copy.querySelectorAll('[aria-hidden="true"]').forEach((child) => child.remove());
      return copy.textContent.replace(/\\s+/g, ' ').trim();
    };
    const buttons = [...root.querySelectorAll('button')];
    const button = buttons.find((item) => label(item) === ${JSON.stringify(text)} && !item.disabled);
    if (!button) return { labels: buttons.map(label), path: location.pathname };
    button.click();
    return true;
  })()`;
  const clicked = await page.evaluate(expression);
  assert.equal(clicked, true, `Expected visible UI button was not found: ${text}; available: ${JSON.stringify(clicked)}`);
}

function buttonExistsExpression(selector, text) {
  return `(() => {
    const label = (item) => {
      const copy = item.cloneNode(true);
      copy.querySelectorAll('[aria-hidden="true"]').forEach((child) => child.remove());
      return copy.textContent.replace(/\\s+/g, ' ').trim();
    };
    return [...document.querySelectorAll(${JSON.stringify(selector)})].some((item) => label(item) === ${JSON.stringify(text)});
  })()`;
}

async function saveScreenshot(name) {
  const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const path = join(evidenceDirectory, `${runId}-${name}.png`);
  writeFileSync(path, Buffer.from(result.data, 'base64'), { mode: 0o600 });
  return path;
}

async function run() {
  mkdirSync(evidenceDirectory, { recursive: true });
  mkdirSync(profilePath, { recursive: false, mode: 0o700 });
  browserProcess = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profilePath}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  browserPid = browserProcess.pid;
  assert.ok(browserPid, 'Chrome process did not start.');
  const activePortPath = join(profilePath, 'DevToolsActivePort');
  await waitForFile(activePortPath, 20000);
  const [port] = readFileSync(activePortPath, 'utf8').trim().split(/\r?\n/);
  remotePort = Number(port);
  assert.ok(Number.isInteger(remotePort) && remotePort > 0);
  const targetsResponse = await fetch(`http://127.0.0.1:${remotePort}/json/list`);
  const targets = await targetsResponse.json();
  const target = targets.find((entry) => entry.type === 'page');
  assert.ok(target?.webSocketDebuggerUrl, 'Chrome page target is unavailable.');

  const WebSocketCtor = globalThis.WebSocket;
  assert.equal(typeof WebSocketCtor, 'function', 'Node native WebSocket is required.');
  browserSocket = new WebSocketCtor(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome DevTools connection timed out.')), 10000);
    browserSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    browserSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools connection failed.')); }, { once: true });
  });
  page = new Cdp(browserSocket);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Runtime.addBinding', { name: '__kalashBrowserBinding' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeSource });
  await page.send('Page.navigate', { url: `${ORIGIN}/temples/temple-01` });
  await waitForPage(() => document.querySelector('h1')?.innerText === 'Lotus Courtyard');
  const detailScreenshot = await saveScreenshot('temple-detail');

  const initialTrace = await page.evaluate('window.__KALASH_WALLET_TRACE__ ?? []');
  assert.ok(Array.isArray(initialTrace));
  await clickButton('Connect MetaMask');
  await waitForPage(buttonExistsExpression('header button', 'Verify wallet'));
  await clickButton('Verify wallet', { within: 'header' });
  await waitForPage(() => document.querySelector('header .connection-dot.is-verified') !== null, 30000);
  assert.ok(accountAuthorized, 'Injected test process did not authorize the dedicated donor.');
  if (resumableItem) {
    const restoreDeadline = Date.now() + 30000;
    while (latestDonation?.id !== resumableItem.id && Date.now() < restoreDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(latestDonation?.id, resumableItem.id, 'The UI did not restore the existing unresolved intent.');
    assert.equal(latestDonation.status, 'intent', 'The existing intent is no longer safe to resume.');
  }

  await clickButton('Collection', { within: '.bottom-nav' });
  await waitForPage(() => document.querySelector('.collection-page') !== null);
  const baselineUntil = Date.now() + 20000;
  while (!priorCollection && Date.now() < baselineUntil) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(priorCollection, 'Could not capture the pre-donation collection from the UI.');
  assert.ok(BigInt(priorCollection.pointUnits) >= 0n);

  await clickButton('Explore', { within: '.bottom-nav' });
  await waitForPage(() => document.querySelector('.explore-page') !== null);
  const detailCardClicked = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.temple-list-card, .map-temple-list button')]
      .find((element) => element.innerText.includes('Lotus Courtyard'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!detailCardClicked) {
    await page.evaluate(`location.href = ${JSON.stringify(`${ORIGIN}/temples/temple-01`)}`);
  }
  await waitForPage(() => document.querySelector('.detail-page h1')?.innerText === 'Lotus Courtyard');

  const donationStartedAt = new Date().toISOString();
  await clickButton('Donate 0.010000 USDC');
  const donationDeadline = Date.now() + 180000;
  while (Date.now() < donationDeadline) {
    if (receiverError) throw receiverError;
    if (item?.mintStatus === 'minted') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(item, 'The real UI did not create an intent.');
  assert.equal(item.intent.amount, '10000');
  assert.ok(item.operations.donate?.hash, 'The real UI did not submit the vault donation transaction.');
  assert.equal(item.operations.donate.amountUnits, DONATION_UNITS.toString());
  if (expectedApprovalRequired) {
    assert.ok(item.operations.approve?.hash, 'The UI did not submit the required exact USDC approval.');
    assert.equal(item.operations.approve.amountUnits, DONATION_UNITS.toString());
  } else {
    assert.equal(item.operations.approve?.hash, undefined, 'The UI submitted an unnecessary approval.');
  }
  assert.equal(item.status, 'confirmed');
  assert.equal(item.mintStatus, 'minted', 'Central did not report a real mint before timeout.');

  const collectionButton = 'Skip photo · View collection';
  await waitForPage(buttonExistsExpression('button', collectionButton), 30000);
  await clickButton(collectionButton);
  await waitForPage(() => document.querySelector('.collection-page') !== null);
  const collectionDeadline = Date.now() + 20000;
  while ((!latestCollection || latestCollection.currentDonationMinted !== true) && Date.now() < collectionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(latestCollection?.currentDonationMinted, 'Reloaded Collection API did not include the real minted donation.');
  assert.equal(BigInt(latestCollection.pointUnits), BigInt(item.priorPointUnits) + DONATION_UNITS);
  assert.equal(latestCollection.remoteStampCount, item.priorRemoteStampCount + 1);
  const expectedStampText = `Collected ${item.priorRemoteStampCount + 1} ${item.priorRemoteStampCount === 0 ? 'time' : 'times'}`;
  await waitForPage(`document.querySelector('.stamp-book .stamp-slot.has-stamp')?.innerText.includes(${JSON.stringify(expectedStampText)})`);
  assert.ok(await page.evaluate(`document.querySelector('.stamp-book .stamp-slot.has-stamp')?.innerText.includes(${JSON.stringify(expectedStampText)})`));
  const collectionScreenshot = await saveScreenshot('collection');

  await page.send('Page.reload', { ignoreCache: true });
  await waitForPage(() => document.querySelector('.collection-page') !== null, 30000);
  const collectionReloadDeadline = Date.now() + 30000;
  const initialCollectionSnapshot = latestCollection?.at;
  while ((!latestCollection || latestCollection.at === initialCollectionSnapshot || !latestCollection.currentDonationMinted) && Date.now() < collectionReloadDeadline) {
    if (receiverError) throw receiverError;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!latestCollection || latestCollection.at === initialCollectionSnapshot || !latestCollection.currentDonationMinted) {
    const hasVerifyButton = await page.evaluate(`[...document.querySelectorAll('header button')].some((button) => button.innerText.trim() === 'Verify wallet')`);
    if (hasVerifyButton) {
      await clickButton('Verify wallet', { within: 'header' });
      await waitForPage(() => document.querySelector('header .connection-dot.is-verified') !== null, 30000);
    }
    const retryDeadline = Date.now() + 20000;
    while ((!latestCollection || latestCollection.at === initialCollectionSnapshot || !latestCollection.currentDonationMinted) && Date.now() < retryDeadline) {
      if (receiverError) throw receiverError;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(latestCollection && latestCollection.at !== initialCollectionSnapshot, 'Collection did not reload from Central after browser refresh.');
  assert.equal(latestCollection.currentDonationMinted, true);
  assert.equal(BigInt(latestCollection.pointUnits), BigInt(item.priorPointUnits) + DONATION_UNITS);
  assert.equal(latestCollection.remoteStampCount, item.priorRemoteStampCount + 1);
  assert.ok(await page.evaluate(`document.querySelector('.stamp-book .stamp-slot.has-stamp')?.innerText.includes(${JSON.stringify(expectedStampText)})`));
  const reloadedScreenshot = await saveScreenshot('collection-reload');

  await clickButton('History', { within: '.bottom-nav' });
  await waitForPage(() => document.querySelector('.history-page h1')?.innerText === 'Donation history');
  const historyDeadline = Date.now() + 20000;
  while (latestHistory?.currentDonationCount !== 1 && Date.now() < historyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(latestHistory?.currentDonationCount, 1, 'Central History did not include this donation exactly once.');
  assert.equal(latestHistory.donation.amount, DONATION_UNITS.toString(), 'History API returned incorrect base units.');
  assert.equal(latestHistory.donation.status, 'confirmed');
  assert.equal(latestHistory.donation.mintStatus, 'minted');
  assert.match(await page.evaluate(`document.querySelector('.history-timeline')?.innerText ?? ''`), /0\\.010000\\s*USDC/);
  const historyScreenshot = await saveScreenshot('history');

  item.completed = true;
  item.finalPointUnits = latestCollection.pointUnits;
  item.mintTxHash = latestCollection.currentDonationMintTxHash ?? item.mintTxHash;
  item.tokenId = latestCollection.currentDonationTokenId ?? item.tokenId;
  item.mintedAt ??= new Date().toISOString();
  item.uiEvidence = {
    sourceCommit,
    appScriptSha256: appScriptHash,
    chromeVersion,
    detailScreenshot,
    collectionScreenshot,
    reloadedScreenshot,
    historyScreenshot,
    donationStartedAt,
    collectionReloadedAt: latestCollection.at,
  };
  persist();
  console.log(JSON.stringify({
    result: 'real_browser_ui_donation_central_mint_collection_reload_passed',
    origin: ORIGIN,
    sourceCommit,
    appScriptSha256: appScriptHash,
    chromeVersion,
    donationId: item.id,
    amount: item.intent.amount,
    approvalAmount: item.operations.approve?.amountUnits ?? null,
    fee: item.intent.fee,
    net: item.intent.net,
    donationTxHash: item.donationTxHash,
    donationSubmittedAt: item.operations.donate.startedAt,
    donationConfirmedAt: item.confirmedAt,
    mintTxHash: item.mintTxHash,
    tokenId: item.tokenId,
    mintedAt: item.mintedAt,
    priorPointUnits: item.priorPointUnits,
    pointUnits: latestCollection.pointUnits,
    priorRemoteStampCount: item.priorRemoteStampCount,
    remoteStampCount: latestCollection.remoteStampCount,
    collectionReloadedAt: latestCollection.at,
    evidence: [detailScreenshot, collectionScreenshot, reloadedScreenshot],
    historyEvidence: historyScreenshot,
    limitation: 'Dedicated isolated test-process injected connector; normal MetaMask browser evidence remains separate.',
  }, null, 2));
}

try {
  await run();
} catch (error) {
  const name = error?.name ?? 'Error';
  const message = error instanceof Error ? error.message : 'Browser E2E failed.';
  const ui = await safeUiDiagnostics();
  console.error(JSON.stringify({
    result: 'real_browser_ui_e2e_failed',
    name,
    message: message.slice(0, 400),
    donationId: item?.id ?? null,
    operationNames: item ? Object.keys(item.operations) : [],
    status: item?.status ?? null,
    mintStatus: item?.mintStatus ?? null,
    ui,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (browserSocket?.readyState === WebSocket.OPEN) browserSocket.close();
  if (browserPid && process.platform === 'win32') {
    const stop = `$root=${browserPid}; $all=@(Get-CimInstance Win32_Process); $ids=@($root); do { $children=@($all | Where-Object { $ids -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId } | Where-Object { $ids -notcontains $_ }); $changed=$children.Count -gt 0; $ids += $children } while($changed); foreach($id in ($ids | Sort-Object -Descending)) { if(Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', stop], { stdio: 'ignore', windowsHide: true });
  } else if (browserProcess && !browserProcess.killed) {
    browserProcess.kill();
  }
  try { rmSync(profilePath, { recursive: true, force: true }); } catch {}
  if (lock) {
    closeSync(lock);
    try { rmSync(lockPath, { force: true }); } catch {}
  }
}
