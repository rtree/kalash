import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, TransactionReceiptNotFoundError, type Hex, type Log } from 'viem';
import { cashFeeAbi, type CashFeeInvoice } from '../src/payout.ts';
import { USDC } from '../src/shared.ts';
import { CASH_DENOMINATIONS, type CashEvent, type CashEventData, type CashInventory } from '../src/cash.ts';

// Local serializable transaction double, NOT a Firestore emulator or live-service test.
class LocalStore {
  records = new Map<string, any>();
  failNextCommit = false;
  private tail: Promise<unknown> = Promise.resolve();
  collection(path: string): any {
    const query = (field?: string, expected?: unknown, maximum = Infinity): any => ({
      doc: (id: string) => this.ref(`${path}/${id}`),
      where: (key: string, operator: string, value: unknown) => {
        assert.equal(operator, '==');
        return query(key, value, maximum);
      },
      limit: (limit: number) => query(field, expected, limit),
      get: async () => {
        const docs = [...this.records.entries()].filter(([key, data]) => key.startsWith(`${path}/`)
          && key.slice(path.length + 1).indexOf('/') === -1 && (!field || data[field] === expected))
          .slice(0, maximum).map(([key]) => ({ ...this.snapshot(key), id: key.slice(path.length + 1) }));
        return { docs, size: docs.length };
      },
    });
    return query();
  }
  private snapshot(path: string) {
    const data = structuredClone(this.records.get(path));
    return { exists: data !== undefined, data: () => structuredClone(data), get: (field: string) => data?.[field] };
  }
  private ref(path: string): any {
    return {
      path, id: path.split('/').at(-1),
      collection: (child: string) => this.collection(`${path}/${child}`),
      get: async () => this.snapshot(path),
      create: async (data: unknown) => this.runTransaction(async (tx: any) => tx.create({ path }, data)),
      update: async (data: unknown) => this.runTransaction(async (tx: any) => tx.update({ path }, data)),
      set: async (data: unknown) => this.runTransaction(async (tx: any) => tx.set({ path }, data)),
    };
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      const changes: { type: string; path: string; data: any }[] = [];
      const tx = {
        get: async (ref: any) => {
          assert.equal(changes.length, 0, 'Firestore transactions must read before writing');
          return this.snapshot(ref.path);
        },
        create: (ref: any, data: any) => changes.push({ type: 'create', path: ref.path, data: structuredClone(data) }),
        update: (ref: any, data: any) => changes.push({ type: 'update', path: ref.path, data: structuredClone(data) }),
        set: (ref: any, data: any) => changes.push({ type: 'set', path: ref.path, data: structuredClone(data) }),
      };
      const result = await fn(tx);
      const next = new Map(this.records);
      for (const change of changes) {
        if (change.type === 'create') assert.ok(!next.has(change.path), `duplicate create: ${change.path}`);
        if (change.type === 'update') assert.ok(next.has(change.path), `missing update: ${change.path}`);
        next.set(change.path, change.type === 'update' ? { ...next.get(change.path), ...change.data } : change.data);
      }
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected local atomic commit failure'); }
      this.records = next;
      return result;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  read(path: string) { return structuredClone(this.records.get(path)); }
  count(collection: string) { return [...this.records.keys()].filter((path) => path.startsWith(`${collection}/`)).length; }
}
const store = new LocalStore();
const wallet = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}` as Hex);
const other = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}` as Hex);
const adminWallet = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}` as Hex);
const originalReadFile = readFileSync;
mock.module('node:fs', { namedExports: {
  readFileSync: (...args: Parameters<typeof readFileSync>) => args[0] === 'config/temple-admins.public.json'
    ? JSON.stringify({ chainId: 84532, templeWalletAdmins: { 'temple-01': adminWallet.address } })
    : originalReadFile(...args),
} });
let feeReceipt: { status: 'success' | 'reverted'; to: Hex; from: Hex; blockHash: Hex; blockNumber: bigint; logs: Log[] } | null = null;
const origin = 'http://127.0.0.1';
const auth = `Bearer ${'c'.repeat(64)}`;
const cookie = `kalash_atm=${'b'.repeat(64)}`;
const streamId = '10000000-0000-4000-8000-000000000001';
const cashSessionId = '20000000-0000-4000-8000-000000000001';
const visitId = 'a'.repeat(64);
const atmId = 'atm-01';
const visitPath = `visits/${visitId}`;
const sessionPath = `cashSessions/${cashSessionId}`;
mock.module('../src/server/config.ts', { namedExports: {
  db: store, origin, project: 'local-cash-tests-only', auth: {}, signer: {}, minter: other,
  chain: {
    getBlockNumber: async () => 1n,
    getChainId: async () => 84532,
    getContractEvents: async () => [],
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!feeReceipt) throw new TransactionReceiptNotFoundError({ hash });
      return feeReceipt;
    },
    getBlock: async () => ({ number: 1n, hash: `0x${'d'.repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  },
  deployment: { stamp: '0x0000000000000000000000000000000000000001', vault: '0x0000000000000000000000000000000000000002',
    cashFeeVault: '0x0000000000000000000000000000000000000003' },
  publicConfig: {},
} });
mock.module('../src/server/authentication.ts', { namedExports: {
  identity: async (authorization: string) => {
    if (authorization === 'Bearer payout-test-owner') return wallet.address;
    if (authorization === 'Bearer local-owner') return wallet.address;
    if (authorization === 'Bearer local-other') return other.address;
    const { HttpError } = await import('../src/server/errors.ts');
    throw new HttpError(401, 'AUTH_REQUIRED', 'Local test identity required.');
  },
  challenge: () => { throw new Error('Not used by local cash tests'); },
  verifyChallenge: () => { throw new Error('Not used by local cash tests'); },
} });
mock.module('../src/server/photos.ts', { namedExports: Object.fromEntries([
  'cleanupPhotoLifecycle', 'getBoardPhoto', 'getPhotoEligibility', 'listBoardPhotos',
  'listOwnedPhotos', 'uploadPhoto', 'withdrawPhoto',
].map((name) => [name, () => { throw new Error('Photos are outside the local cash store test boundary'); }])) });
const atm = await import('../src/server/atm.ts');
const cash = await import('../src/server/cash.ts');
const payout = await import('../src/server/payout.ts');
const { createCentralServer } = await import('../src/server/main.ts');
const server = createCentralServer();
let url: string;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
function inventory(count = 0): CashInventory {
  return {
    levels: CASH_DENOMINATIONS.map((valuePaise) => ({ valuePaise, payout: valuePaise === '10000' ? count : 0, cashbox: 0 })),
    counters: { stored: count, stacked: 0, dispensed: 0, transferredToStack: 0 },
  };
}
function seed() {
  store.records.clear();
  store.failNextCommit = false;
  feeReceipt = null;
  const now = Date.now();
  store.records.set(`atms/${atmId}`, {
    id: atmId, name: 'Local ATM', templeId: 'temple-01', enabled: true, cashEnabled: true,
    credentialHash: atm.credentialHash('c'.repeat(64)), activeVisitId: visitId,
    screenHash: atm.credentialHash('b'.repeat(64)), screenExpiresAt: now + 60_000,
    controllerHealth: {
      sequence: 1, receivedAt: now, usbConnected: true, connectionOpen: true,
      deviceStarted: true, routesVerified: true, pollerOwned: true, deviceId: 'local-double',
    },
  });
  store.records.set(visitPath, {
    id: visitId, atmId, templeId: 'temple-01', mode: 'cash', state: 'accepting', expiresAt: now + 120_000,
    cashSessionId, cashDeadline: now + 120_000, ownerWallet: wallet.address, cashConsentChallenge: 'consent',
    cashAcceptedPaise: '0',
  });
  store.records.set('cashConsentChallenges/consent', {
    used: true, visitId, cashSessionId, atmId, templeId: 'temple-01', wallet: wallet.address,
  });
  store.records.set(`controllerCommands/cash-start-${cashSessionId}`, {
    commandId: `cash-start-${cashSessionId}`, atmId, visitId, cashSessionId, templeId: 'temple-01',
    type: 'start_cash', state: 'reported', expiresAt: now + 120_000,
  });
}
let previousCashPolicy: string | undefined;
beforeEach(() => {
  previousCashPolicy = process.env.KALASH_CASH_POLICY;
  process.env.KALASH_CASH_POLICY = 'strict';
  seed();
});
afterEach(() => {
  if (previousCashPolicy === undefined) delete process.env.KALASH_CASH_POLICY;
  else process.env.KALASH_CASH_POLICY = previousCashPolicy;
});
test('payout rejects donor-wallet admin escalation and cannot discover fee invoices', async () => {
  await assert.rejects(payout.getTemplePayout(atmId, wallet.address), { code: 'TEMPLE_ADMIN_REQUIRED' });
  const response = await fetch(`${url}/api/temple-admin/${atmId}`, { headers: { Authorization: 'Bearer payout-test-owner' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'TEMPLE_ADMIN_REQUIRED');
});
test('active payout disables Cash/Crypto creation and signed cash starts without changing the cash flag', async () => {
  const registered = store.read(`atms/${atmId}`);
  store.records.set(`atms/${atmId}`, { ...registered, activeVisitId: null,
    activePayoutId: '12345678-1234-4234-8234-123456789abc' });
  const view = await atm.getAtm(atmId, cookie);
  assert.equal(view.cashReceptionAvailable, false);
  assert.equal(view.cryptoDonationEnabled, false);
  assert.equal(store.read(`atms/${atmId}`).cashEnabled, true);
  await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'PAYOUT_IN_PROGRESS' });
  await assert.rejects(atm.createVisit(atmId, cookie, 'crypto', randomUUID()), { code: 'PAYOUT_IN_PROGRESS' });
});
test('payout inventory rejects foreign controller, nonempty escrow and open reception without bezel check', async () => {
  const report = { observedAt: Date.now(), deviceId: 'local-double', deviceState: 'DISABLED',
    escrowEmpty: true, inventory: inventory(), rawSequence: 1 };
  await assert.rejects(payout.reportPayoutInventory(atmId, 'Bearer wrong', report), { code: 'CONTROLLER_AUTH_REQUIRED' });
  await assert.rejects(payout.reportPayoutInventory(atmId, auth, { ...report, escrowEmpty: false }), { code: 'PAYOUT_INVENTORY_UNVERIFIED' });
  await assert.rejects(payout.reportPayoutInventory(atmId, auth, report), { code: 'PAYOUT_INVENTORY_NOT_IDLE' });
  store.records.set(`atms/${atmId}`, { ...store.read(`atms/${atmId}`), activeVisitId: null });
  assert.deepEqual(await payout.reportPayoutInventory(atmId, auth, report), { accepted: true });
  assert.deepEqual(store.read(`atms/${atmId}`).payoutInventory, report);
  const refreshed = { ...report, observedAt: report.observedAt + 1 };
  assert.deepEqual(await payout.reportPayoutInventory(atmId, auth, refreshed), { accepted: true });
  assert.deepEqual(store.read(`atms/${atmId}`).payoutInventory, refreshed);
  await assert.rejects(payout.reportPayoutInventory(atmId, auth, report), { code: 'STALE_PAYOUT_INVENTORY' });
  await assert.rejects(payout.reportPayoutInventory(atmId, auth, { ...report, inventory: inventory(1) }), { code: 'STALE_PAYOUT_INVENTORY' });
});
test('paired screen cannot bypass admin membership, fee settlement or active donation with payout QR', async () => {
  await assert.rejects(payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, 'kalash_atm=wrong'),
    { code: 'ATM_PAIRING_REQUIRED' });
  await assert.rejects(payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie),
    { code: 'ATM_BUSY_OR_LOCKED' });
  assert.equal(store.count('cashPayouts'), 0);
});
test('payout and inventory HTTP routes require registered Controller and exact origin', async () => {
  const noAuth = await fetch(`${url}/api/controller/${atmId}/payout-command`);
  assert.equal(noAuth.status, 401);
  const originMismatch = await fetch(`${url}/api/controller/${atmId}/payout-inventory`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Origin: 'http://foreign.invalid' }, body: '{}',
  });
  assert.equal(originMismatch.status, 403);
});
async function settledCashSource(count = 1) {
  await start();
  for (let index = 1; index <= count; index++) await stored(index, index * 2);
  store.records.set(visitPath, { ...store.read(visitPath), cashCloseRequested: true });
  await post(closeEvent(count * 2 + 2, count));
  await atm.closeVisit(atmId, cookie, visitId);
  await payout.reportPayoutInventory(atmId, auth, { observedAt: Date.now(), deviceId: 'local-double',
    deviceState: 'DISABLED', escrowEmpty: true, inventory: inventory(count), rawSequence: 2 });
  return payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
}
function feeLogs(invoice: CashFeeInvoice, hash: Hex): Log[] {
  const blockHash = `0x${'d'.repeat(64)}` as Hex;
  const common = { blockHash, blockNumber: 1n, transactionHash: hash, transactionIndex: 0, removed: false };
  const concrete = (topics: ReturnType<typeof encodeEventTopics>): Log['topics'] => {
    const entries = topics.map((topic) => {
      assert.ok(typeof topic === 'string'); return topic;
    });
    const first = entries.shift(); assert.ok(first);
    return [first, ...entries];
  };
  return [
    { ...common, address: invoice.vault, logIndex: 0,
      topics: concrete(encodeEventTopics({ abi: cashFeeAbi, eventName: 'FeePaid',
        args: { invoiceId: invoice.invoiceId, payer: invoice.payer, templeId: invoice.templeKey } })),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(invoice.amount), invoice.recipient]) },
    { ...common, address: USDC, logIndex: 1, topics: concrete(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer',
      args: { from: invoice.payer, to: invoice.recipient } })),
      data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(invoice.amount)]) },
  ];
}
async function payInvoice(invoice: CashFeeInvoice) {
  const hash = `0x${'e'.repeat(64)}` as Hex;
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  feeReceipt = { status: 'success', to: invoice.vault, from: adminWallet.address, blockHash: `0x${'d'.repeat(64)}`,
    blockNumber: 1n, logs: feeLogs(invoice, hash) };
  return payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, { txHash: hash });
}
test('exact cash invoice requires one reconciled source, survives unknown payment and reserves no second fee', async () => {
  const invoice = await settledCashSource();
  assert.equal(invoice.amount, '30000');
  assert.equal(invoice.cashPaise, '10000');
  assert.equal(invoice.payer, adminWallet.address);
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }), { code: 'INVOICE_ALREADY_PENDING' });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  await assert.rejects(payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId), { code: 'FEE_SUBMISSION_UNAVAILABLE' });
  const pending = await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, {});
  assert.equal(pending.status, 'unknown');
  assert.equal(store.count('cashFeeCoverage'), 0);
  assert.equal(store.read(visitPath).state, 'closed');
});
test('FeePaid/transfer evidence atomically covers exact donations without rewriting donation history', async () => {
  const invoice = await settledCashSource();
  const sourcePath = `donations/${invoice.donationIds[0]}`;
  const before = store.read(sourcePath);
  const paid = await payInvoice(invoice);
  assert.equal(paid.status, 'paid');
  assert.equal(store.count('cashFeeCoverage'), 1);
  assert.deepEqual(store.read(sourcePath), before);
  assert.equal((await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, {})).status, 'paid');
  assert.equal(store.count('cashFeeChainEvents'), 1);
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }), { code: 'NO_UNSETTLED_CASH' });
});
test('unsettled payout is rejected; real admin signature creates one exclusive durable command', async () => {
  const invoice = await settledCashSource();
  await assert.rejects(payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie), { code: 'UNSETTLED_CASH' });
  await payInvoice(invoice);
  const approval = await payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie);
  const context = await payout.getPayoutApproval(approval.approvalId);
  const foreign = await other.signMessage({ message: context.message });
  await assert.rejects(payout.approvePayout(atmId, adminWallet.address, approval.approvalId, { signature: foreign }),
    { code: 'PAYOUT_SIGNATURE_INVALID' });
  assert.equal(store.count('cashPayouts'), 0);
  const signature = await adminWallet.signMessage({ message: context.message });
  const approved = await payout.approvePayout(atmId, adminWallet.address, approval.approvalId, { signature });
  const repeated = await payout.approvePayout(atmId, adminWallet.address, approval.approvalId, { signature });
  assert.deepEqual(repeated, approved);
  assert.equal(store.count('cashPayouts'), 1);
  const delivered = await payout.getPayoutCommand(atmId, auth);
  assert.equal(delivered.command?.amountPaise, '10000');
  assert.equal(delivered.command?.payoutId, approved.payoutId);
  assert.equal(store.read(`atms/${atmId}`).activePayoutId, approved.payoutId);
  assert.equal(store.read(`atms/${atmId}`).cashEnabled, true);
  await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'PAYOUT_IN_PROGRESS' });
});
test('cash inventory change after QR cannot dispatch the approved snapshot', async () => {
  const invoice = await settledCashSource(); await payInvoice(invoice);
  const approval = await payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie);
  const context = await payout.getPayoutApproval(approval.approvalId);
  const registered = store.read(`atms/${atmId}`);
  store.records.set(`atms/${atmId}`, { ...registered,
    payoutInventory: { ...registered.payoutInventory, inventory: inventory(2) } });
  await assert.rejects(payout.approvePayout(atmId, adminWallet.address, approval.approvalId,
    { signature: await adminWallet.signMessage({ message: context.message }) }), { code: 'PAYOUT_BASELINE_CHANGED' });
  assert.equal(store.count('cashPayouts'), 0);
});
test('expired start authorization retires only an undispatched payout without resending or changing money', async (t) => {
  const invoice = await settledCashSource(); await payInvoice(invoice);
  const approval = await payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie);
  const context = await payout.getPayoutApproval(approval.approvalId);
  const result = await payout.approvePayout(atmId, adminWallet.address, approval.approvalId,
    { signature: await adminWallet.signMessage({ message: context.message }) });
  const record = store.read(`cashPayouts/${result.payoutId}`);
  t.mock.timers.enable({ apis: ['Date'], now: record.command.expiresAt });
  assert.deepEqual(await payout.getPayoutCommand(atmId, auth), { command: null });
  assert.equal(store.read(`cashPayouts/${result.payoutId}`).state, 'precondition_failed');
  assert.equal(store.read(`atms/${atmId}`).activePayoutId, null);
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, undefined);
  assert.equal(store.read(`cashPayoutAccounts/${atmId}`).dispensedPaise, '0');
  assert.equal(store.count('cashFeeCoverage'), 1);
});
async function approvedPayout(count = 1) {
  const invoice = await settledCashSource(count); await payInvoice(invoice);
  const approval = await payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie);
  const context = await payout.getPayoutApproval(approval.approvalId);
  await payout.approvePayout(atmId, adminWallet.address, approval.approvalId,
    { signature: await adminWallet.signMessage({ message: context.message }) });
  const delivered = await payout.getPayoutCommand(atmId, auth);
  assert.ok(delivered.command);
  return delivered.command;
}
test('payout completion needs dispatch, DISPENSED, COMPLETED, later idle and exact counters; ACK is idempotent', async () => {
  const command = await approvedPayout();
  const report = (state: string, extra: Record<string, unknown> = {}) =>
    payout.reportPayoutCommand(atmId, auth, { commandId: command.commandId, state, ...extra });
  await assert.rejects(report('dispatching'), { code: 'PAYOUT_STATE_CONFLICT' });
  for (const state of ['received', 'validated', 'dispatching']) await report(state);
  const after = inventory(1); after.levels.forEach((level) => { level.payout = 0; }); after.counters.dispensed = 1;
  const evidence = { before: command.baseline, after, deviceId: 'local-double', streamId,
    dispatchRawSequence: 2, dispensedRawSequence: 3, dispensedObservedAt: command.createdAt + 1,
    completedRawSequence: 4, completedObservedAt: command.createdAt + 2, idleRawSequence: 4,
    idleObservedAt: command.createdAt + 3, deviceState: 'DISABLED', escrowEmpty: true };
  await assert.rejects(report('observed', { evidence: { ...evidence, escrowEmpty: false } }), { code: 'PAYOUT_COMPLETION_MISMATCH' });
  await assert.rejects(report('observed', { evidence: { ...evidence, idleObservedAt: evidence.completedObservedAt } }),
    { code: 'PAYOUT_COMPLETION_MISMATCH' });
  assert.equal(store.read(`cashPayouts/${command.payoutId}`).state, 'dispatching');
  await report('observed', { evidence });
  const ack = await report('reported');
  assert.deepEqual(await report('reported'), ack);
  assert.equal(store.read(`atms/${atmId}`).activePayoutId, null);
  assert.equal(store.read(`cashPayoutAccounts/${atmId}`).dispensedPaise, '10000');
  assert.equal(store.count('cashFeeCoverage'), 1);
});
test('unknown partial payout stays locked until signed reconciliation; settled remainder is not charged twice', async () => {
  const command = await approvedPayout(2);
  const report = (state: string, extra: Record<string, unknown> = {}) =>
    payout.reportPayoutCommand(atmId, auth, { commandId: command.commandId, state, ...extra });
  for (const state of ['received', 'validated', 'dispatching']) await report(state);
  const after = inventory(2); after.levels.find((level) => level.valuePaise === '10000')!.payout = 1; after.counters.dispensed = 1;
  const endState = { before: command.baseline, after, deviceId: 'local-double', streamId, rawSequence: 6,
    observedAt: Date.now(), deviceState: 'DISABLED', escrowEmpty: true,
    dispensedPaise: '10000', remainingPaise: '10000' };
  await report('unknown', { reason: 'synthetic_interrupted_payout', endState });
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  assert.equal((await payout.getPayoutCommand(atmId, auth)).command, null);
  await assert.rejects(report('reported'), { code: 'PAYOUT_STATE_CONFLICT' });
  await assert.rejects(payout.createPayoutReconciliation(atmId, wallet.address, { payoutId: command.payoutId }),
    { code: 'TEMPLE_ADMIN_REQUIRED' });
  const challenge = await payout.createPayoutReconciliation(atmId, adminWallet.address, { payoutId: command.payoutId });
  assert.ok('message' in challenge && typeof challenge.message === 'string');
  await payout.createPayoutReconciliation(atmId, adminWallet.address, { payoutId: command.payoutId,
    signature: await adminWallet.signMessage({ message: challenge.message }) });
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  const authorization = await payout.getPayoutReconciliationCommand(atmId, auth); assert.ok(authorization.command);
  const reconciled = { reason: 'operator_reconciled_partial_end_state', endState,
    reconciliationApprovalId: authorization.command.approvalId };
  await report('unknown', reconciled); await report('unknown', reconciled);
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, false);
  assert.equal(store.read(`cashPayoutAccounts/${atmId}`).dispensedPaise, '10000');
  await payout.reportPayoutInventory(atmId, auth, { observedAt: Date.now(), deviceId: 'local-double', deviceState: 'DISABLED',
    escrowEmpty: true, inventory: after, rawSequence: 7 });
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }), { code: 'NO_UNSETTLED_CASH' });
  const next = await payout.createPayoutApproval(atmId, { requestId: randomUUID() }, undefined, cookie);
  const context = await payout.getPayoutApproval(next.approvalId);
  await payout.approvePayout(atmId, adminWallet.address, next.approvalId,
    { signature: await adminWallet.signMessage({ message: context.message }) });
  const remaining = await payout.getPayoutCommand(atmId, auth);
  assert.equal(remaining.command?.amountPaise, '10000');
  assert.notEqual(remaining.command?.payoutId, command.payoutId);
  assert.equal(store.count('cashFeeCoverage'), 1);
});
const makeEvent = (sequence: number, data: CashEventData): CashEvent => ({
  streamId, sequence, deviceEventId: `${streamId}:${sequence}`, occurredAt: Date.now(),
  visitId, cashSessionId, ...data,
});
const post = (event: CashEvent | Record<string, unknown>) => cash.reportControllerCashEvent(atmId, auth, event as Record<string, unknown>);
async function mismatchedClose() {
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  const event = closeEvent();
  assert.equal(event.type, 'intake_closed');
  if (event.type === 'intake_closed') event.data.inventory = inventory(2);
  await post(event);
  return event;
}
test('strict default preserves the historical mismatch reconciliation lock', async () => {
  delete process.env.KALASH_CASH_POLICY;
  await mismatchedClose();
  assert.equal((await atm.getAtm(atmId, cookie)).cashPolicy, 'strict');
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(store.count('donations'), 0);
});
for (const finish of ['screen-close', 'screen-done', 'wallet-done'] as const) {
  test(`Interim ${finish} retires a mismatched closed ledger without donation and permits a new signed intake`, async () => {
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    const close = await mismatchedClose();
    const oldLedger = store.read(sessionPath);
    const oldCommand = store.read(`controllerCommands/cash-start-${cashSessionId}`);
    const oldRaw = store.read(`atms/${atmId}/cashEvents/${close.deviceEventId}`);
    assert.equal(store.read(visitPath).state, 'closed');
    assert.equal(store.read(visitPath).cashHistoricalAuditWarning, true);
    assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
    assert.equal((await cash.getControllerCashSession(atmId, auth)).session, null);
    await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'ATM_BUSY' });
    if (finish === 'screen-close') await atm.closeVisit(atmId, cookie, visitId);
    else if (finish === 'screen-done') await atm.doneCashVisit(atmId, cookie, visitId);
    else {
      await assert.rejects(atm.doneOwnedCashVisit(visitId, other.address, 'temple-01'), { code: 'CASH_VISIT_NOT_OWNER' });
      await atm.doneOwnedCashVisit(visitId, wallet.address, 'temple-01');
    }
    assert.deepEqual(store.read(sessionPath), oldLedger);
    assert.deepEqual(store.read(`controllerCommands/cash-start-${cashSessionId}`), oldCommand);
    assert.deepEqual(store.read(`atms/${atmId}/cashEvents/${close.deviceEventId}`), oldRaw);
    assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
    assert.equal(store.read(`atms/${atmId}`).cashEnabled, true);
    assert.equal(store.count('donations'), 0);
    assert.equal(store.count('walletTempleTotals'), 0);
    assert.equal(store.count('mintJobs'), 0);
    const view = await atm.getAtm(atmId, cookie);
    assert.equal(view.cashPolicy, 'interim-ledger');
    assert.equal(view.cashReceptionAvailable, true);
    const next = (await atm.createVisit(atmId, cookie, 'cash', randomUUID())).visit!;
    await assert.rejects(atm.claimCashVisit(next.id, wallet.address, 'temple-01', '0'.repeat(48), '0x12'),
      { code: 'CASH_CONSENT_INVALID' });
    const consent = await atm.createCashConsentChallenge(next.id, wallet.address, 'temple-01');
    const signature = await wallet.signMessage({ message: consent.message });
    await atm.claimCashVisit(next.id, wallet.address, 'temple-01', consent.nonce, signature);
    const command = (await atm.getControllerCashCommand(atmId, auth)).command!;
    for (const state of ['received', 'validated', 'dispatching', 'observed', 'reported']) {
      await atm.reportControllerCashCommand(atmId, auth, { commandId: command.commandId, state,
        ...(state === 'observed' ? { deviceState: 'ACCEPTING', observedAt: Date.now() } : {}) });
    }
    assert.equal((await cash.getControllerCashSession(atmId, auth)).session?.state, 'accepting');
    assert.equal((await atm.getVisit(next.id, 'temple-01', wallet.address)).cashAcceptanceEnabled, true);
    await post({ ...makeEvent(5, { type: 'intake_started', data: { inventory: inventory(2) } }),
      visitId: next.id, cashSessionId: command.cashSessionId });
    assert.deepEqual(store.read(`cashSessions/${command.cashSessionId}`).ledger.reconciliationReasons, []);
    assert.equal(store.count('controllerCommands'), 2);
  });
}
test('Interim user action retires a preexisting strict reconciling closed mismatch without rewriting evidence', async () => {
  await mismatchedClose();
  const ledger = store.read(sessionPath);
  assert.equal(store.read(visitPath).state, 'reconciling');
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  await atm.doneCashVisit(atmId, cookie, visitId);
  assert.deepEqual(store.read(sessionPath), ledger);
  assert.equal(store.read(visitPath).state, 'closed');
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, null);
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, true);
});
for (const blocker of ['stale', 'disconnected', 'payout'] as const) {
  test(`Interim historical retirement requires fresh physical readiness and excludes ${blocker}`, async () => {
    await mismatchedClose();
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    const registered = store.read(`atms/${atmId}`);
    store.records.set(`atms/${atmId}`, { ...registered,
      ...(blocker === 'payout' ? { activePayoutId: randomUUID() } : {
        controllerHealth: { ...registered.controllerHealth,
          ...(blocker === 'stale' ? { receivedAt: Date.now() - 30_001 } : { usbConnected: false }) },
      }),
    });
    await assert.rejects(atm.doneOwnedCashVisit(visitId, wallet.address, 'temple-01'), { code: 'CASH_CONTROLLER_NOT_READY' });
    assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
    assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, false);
  });
}
for (const blocker of ['fault', 'escrow', 'unknown-command', 'unrequested-close'] as const) {
  test(`Interim ${blocker} remains operationally locked despite historical inventory mismatches`, async () => {
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    await start();
    if (blocker === 'escrow') await post(makeEvent(2, { type: 'note_escrow', data: { ...note(), decision: 'accept' } }));
    else await stored();
    if (blocker !== 'unrequested-close') await atm.doneCashVisit(atmId, cookie, visitId);
    if (blocker === 'unknown-command') {
      const path = `controllerCommands/cash-start-${cashSessionId}`;
      store.records.set(path, { ...store.read(path), state: 'unknown' });
    }
    const event = closeEvent(blocker === 'escrow' ? 3 : 4);
    if (event.type === 'intake_closed') {
      event.data.inventory = inventory(2);
      if (blocker === 'fault') event.data.reason = 'fault';
      if (blocker === 'escrow') event.data.escrowEmpty = false;
    }
    await post(event);
    assert.equal(store.read(visitPath).state, 'reconciling');
    assert.equal(store.read(`atms/${atmId}`).cashHistoricalReconciliationOnly, false);
    await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
    await atm.doneCashVisit(atmId, cookie, visitId);
    assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
    assert.equal(store.count('donations'), 0);
  });
}
test('Interim late conflicting evidence reinstates the physical lock instead of masking an error as historical', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  const close = await mismatchedClose();
  await atm.closeVisit(atmId, cookie, visitId);
  await assert.rejects(post({ ...close, occurredAt: close.occurredAt + 1 }), { code: 'CASH_EVENT_DUPLICATE_MISMATCH' });
  assert.equal(store.read(`atms/${atmId}`).cashHistoricalReconciliationOnly, false);
  assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, false);
  await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'RECONCILIATION_REQUIRED' });
});
test('Interim HTTP exposes closed audit warning lifecycle and owner-authorized screen finish without donation', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  await mismatchedClose();
  const historical = await request(`/api/atm/${atmId}`, undefined, { Cookie: cookie });
  assert.equal(historical.status, 200);
  assert.equal(historical.data.cashPolicy, 'interim-ledger');
  assert.equal(historical.data.visit.state, 'closed');
  const foreign = await request(`/api/atm/${atmId}/visits/${visitId}/close`, {});
  assert.equal(foreign.status, 401);
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
  const finished = await request(`/api/atm/${atmId}/visits/${visitId}/close`, {}, { Cookie: cookie });
  assert.equal(finished.status, 200);
  assert.equal(finished.data.visit, null);
  assert.equal(finished.data.cashReceptionAvailable, true);
  assert.equal(store.count('donations'), 0);
  const next = await request(`/api/atm/${atmId}/visits`, { mode: 'cash', requestId: randomUUID() }, { Cookie: cookie });
  assert.equal(next.status, 201);
  assert.equal(next.data.visit.state, 'awaiting_wallet');
});
test('Interim cannot downgrade a separate invalid physical report when a valid accounting-only close follows', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  await assert.rejects(post({ visitId: 'f'.repeat(64), cashSessionId, type: 'note_stored' }),
    { code: 'INVALID_CASH_EVENT' });
  const event = closeEvent();
  if (event.type === 'intake_closed') event.data.inventory = inventory(2);
  await post(event);
  assert.equal(store.read(`atms/${atmId}`).cashPhysicalReconciliationRequired, true);
  assert.equal(store.read(`atms/${atmId}`).cashHistoricalReconciliationOnly, false);
  await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
  assert.equal(store.count('donations'), 0);
});
async function historicalPendingReturn() {
  await start();
  await post(makeEvent(2, { type: 'note_escrow', data: { ...note(), decision: 'return' } }));
  await atm.doneCashVisit(atmId, cookie, visitId);
  const event = closeEvent(3, 0);
  if (event.type === 'intake_closed') event.data.reason = 'fault';
  await post(event);
}
test('strict closed unresolved RETURN cannot use inventory reporting to bypass reconciliation', async () => {
  await historicalPendingReturn();
  await assert.rejects(payout.reportPayoutInventory(atmId, auth, {
    observedAt: Date.now(), deviceId: 'local-double', deviceState: 'DISABLED',
    escrowEmpty: true, inventory: inventory(), rawSequence: 10,
  }), { code: 'PAYOUT_INVENTORY_NOT_IDLE' });
  assert.equal(store.read(`atms/${atmId}`).cashAuditReadback, undefined);
  await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
});
test('Interim authenticated bound idle audit readback permits user retirement of an old unresolved RETURN without fake outcome', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  await historicalPendingReturn();
  const before = store.read(sessionPath);
  const raw = store.read(`atms/${atmId}/cashEvents/${streamId}:3`);
  const command = store.read(`controllerCommands/cash-start-${cashSessionId}`);
  await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
  const report = { observedAt: Date.now(), deviceId: 'local-double', deviceState: 'DISABLED',
    escrowEmpty: true, inventory: inventory(), rawSequence: 10 };
  await payout.reportPayoutInventory(atmId, auth, report);
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
  assert.deepEqual(store.read(`atms/${atmId}`).cashAuditReadback, { visitId, cashSessionId, report });
  await atm.doneCashVisit(atmId, cookie, visitId);
  assert.deepEqual(store.read(sessionPath), before);
  assert.deepEqual(store.read(`atms/${atmId}/cashEvents/${streamId}:3`), raw);
  assert.deepEqual(store.read(`controllerCommands/cash-start-${cashSessionId}`), command);
  assert.equal(store.read(sessionPath).ledger.notes[0].returned, false);
  assert.equal(store.read(sessionPath).ledger.notes[0].stored, false);
  assert.equal(store.read(sessionPath).ledger.notes[0].credited, false);
  assert.equal(store.read(`atms/${atmId}`).cashAuditReadback, null);
  assert.deepEqual(store.read(visitPath).cashRetirementReadback, report);
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, true);
  const next = (await atm.createVisit(atmId, cookie, 'cash', randomUUID())).visit!;
  const challenge = await atm.createCashConsentChallenge(next.id, wallet.address, 'temple-01');
  await atm.claimCashVisit(next.id, wallet.address, 'temple-01', challenge.nonce,
    await wallet.signMessage({ message: challenge.message }));
  assert.ok((await atm.getControllerCashCommand(atmId, auth)).command);
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('mintJobs'), 0);
});
for (const invalid of ['foreign-visit', 'foreign-session', 'foreign-device', 'stale', 'fault-reason', 'unknown-command'] as const) {
  test(`Interim pending RETURN audit cannot retire using ${invalid} readback or state`, async () => {
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    await historicalPendingReturn();
    const registered = store.read(`atms/${atmId}`);
    store.records.set(`atms/${atmId}`, { ...registered, cashAuditReadback: {
      visitId: invalid === 'foreign-visit' ? 'd'.repeat(64) : visitId,
      cashSessionId: invalid === 'foreign-session' ? randomUUID() : cashSessionId,
      report: { observedAt: invalid === 'stale' ? Date.now() - 30_001 : Date.now(),
        deviceId: invalid === 'foreign-device' ? 'foreign-device' : 'local-double',
        deviceState: 'DISABLED', escrowEmpty: true, inventory: inventory(), rawSequence: 10 },
    } });
    if (invalid === 'fault-reason') store.records.set(visitPath, {
      ...store.read(visitPath), reconciliationReason: 'controller_command_failed',
    });
    if (invalid === 'unknown-command') {
      const path = `controllerCommands/cash-start-${cashSessionId}`;
      store.records.set(path, { ...store.read(path), state: 'unknown' });
    }
    await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
    assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
    assert.equal(store.count('donations'), 0);
  });
}
for (const state of ['unknown', 'failed', 'precondition_failed', 'reported'] as const) {
  test(`Interim terminal ${state} cash start is never retrieved or blindly replayed`, async () => {
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    store.records.set(visitPath, { ...store.read(visitPath), state: 'awaiting_device' });
    const path = `controllerCommands/cash-start-${cashSessionId}`;
    store.records.set(path, { ...store.read(path), state });
    const before = store.read(path);
    await assert.rejects(atm.getControllerCashCommand(atmId, auth), { code: 'CASH_COMMAND_UNAVAILABLE' });
    await assert.rejects(atm.reportControllerCashCommand(atmId, auth, {
      commandId: before.commandId, state: 'received',
    }), { code: 'CASH_COMMAND_STATE_CONFLICT' });
    assert.deepEqual(store.read(path), before);
    assert.equal(store.count('controllerCommands'), 1);
  });
}
const start = () => post(makeEvent(1, { type: 'intake_started', data: { inventory: inventory() } }));
const note = (i = 1) => ({ noteKey: `note-${i}`, valuePaise: '10000', currency: 'INR' as const });
async function stored(i = 1, seq = 2) {
  await post(makeEvent(seq, { type: 'note_escrow', data: { ...note(i), decision: 'accept' } }));
  return post(makeEvent(seq + 1, { type: 'note_stored', data: { ...note(i), route: 'payout' } }));
}
function closeEvent(sequence = 4, count = 1) {
  return makeEvent(sequence, { type: 'intake_closed', data: {
    reason: 'done', inventory: inventory(count), creditedNotes: count, creditedPaise: String(count * 10000),
    uncreditedNotes: 0, disabled: true, escrowEmpty: true, reconciliationReasons: [],
  } });
}
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as any };
}

test('local HTTP: matched Controller event -> Done -> atomic donation, points and existing mint job', async () => {
  const event = makeEvent(1, { type: 'intake_started', data: { inventory: inventory() } });
  const accepted = await request(`/api/controller/${atmId}/cash-events`, event, { Authorization: auth });
  assert.deepEqual(accepted, { status: 200, data: { accepted: true, streamId, sequence: 1 } });
  await stored();
  const screen = await request(`/api/atm/${atmId}`, undefined, { Cookie: cookie });
  assert.equal(screen.data.visit.cashAcceptedPaise, '10000');
  assert.equal(JSON.stringify(screen.data).includes(wallet.address), false);
  const done = await request(`/api/atm/${atmId}/visits/${visitId}/done`, {}, { Cookie: cookie });
  assert.equal(done.data.visit.state, 'closing');
  assert.equal(done.data.visit.cashCloseRequested, true);
  assert.equal(store.count('donations'), 0);
  const controller = await request(`/api/controller/${atmId}/cash-session`, undefined, { Authorization: auth });
  assert.equal(controller.data.session.closeRequested, true);
  assert.equal(controller.data.session.closeReason, 'done');
  await post(closeEvent());
  const donationId = store.read(visitPath).donationId;
  const donation = store.read(`donations/${donationId}`);
  assert.equal(donation.paymentMethod, 'cash');
  assert.equal(donation.chainId, null);
  assert.equal(donation.txHash, null);
  assert.equal(donation.cashAmountPaise, '10000');
  assert.equal(donation.amount, '1000000');
  assert.equal(donation.fee, '30000');
  assert.equal(donation.net, '970000');
  assert.equal(donation.cashFeeStatus, 'unpaid');
  assert.equal(donation.kind, 1);
  assert.equal(donation.mintStatus, 'reserved');
  assert.equal(store.read(`mintJobs/${donationId}`).status, 'reserved');
  assert.equal(store.read(`walletTempleTotals/${wallet.address.toLowerCase()}_temple-01`).points, '10000000');
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
  const confirmed = await request(`/api/atm/${atmId}`, undefined, { Cookie: cookie });
  assert.equal(confirmed.data.visit.state, 'confirmed');
  assert.equal(confirmed.data.visit.donationId, donationId);
  const mine = await request(`/api/visits/${visitId}/mine?templeId=temple-01`, undefined, { Authorization: 'Bearer local-owner' });
  assert.equal(mine.data.donationId, donationId);
  assert.equal(mine.data.cashAcceptedPaise, '10000');
  for (const operation of ['operation', 'verify', 'resolve-approval']) {
    const body = operation === 'operation' ? { operation: 'donate', attemptId: randomUUID() }
      : operation === 'resolve-approval' ? { attemptId: randomUUID(), confirmNoWalletRequest: true } : {};
    const result = await request(`/api/donations/${donationId}/${operation}`, body, { Authorization: 'Bearer local-owner' });
    assert.equal(result.status, 409, operation);
    assert.equal(result.data.error, 'CASH_NOT_CRYPTO', operation);
  }
  const finished = await request(`/api/atm/${atmId}/visits/${visitId}/close`, {}, { Cookie: cookie });
  assert.equal(finished.data.visit, null);
});
test('local HTTP: wallet Done is owner-only, requires origin and is idempotent', async () => {
  await start();
  const path = `/api/visits/${visitId}/cash-done`;
  assert.equal((await request(path, { templeId: 'temple-01' }, { Authorization: 'Bearer local-other' })).status, 403);
  assert.equal((await request(path, { templeId: 'temple-02' }, { Authorization: 'Bearer local-owner' })).status, 403);
  assert.equal((await request(path, { templeId: 'temple-01' }, { Authorization: 'Bearer local-owner', Origin: 'https://foreign.invalid' })).status, 403);
  const done = await request(path, { templeId: 'temple-01' }, { Authorization: 'Bearer local-owner' });
  assert.equal(done.status, 200);
  assert.equal(done.data.state, 'closing');
  const stoppedAt = store.read(visitPath).cashCloseRequestedAt;
  assert.equal((await request(path, { templeId: 'temple-01' }, { Authorization: 'Bearer local-owner' })).status, 200);
  assert.equal(store.read(visitPath).cashCloseRequestedAt, stoppedAt);
  assert.equal(store.count('donations'), 0);
});
test('local HTTP: public/foreign screen and Controller callers cannot mutate or discover cash authority', async () => {
  assert.equal((await request(`/api/controller/${atmId}/cash-session`)).status, 401);
  assert.equal((await request(`/api/atm/${atmId}/visits/${visitId}/done`, {})).status, 401);
  const publicView = await request(`/api/visits/${visitId}?templeId=temple-01`);
  assert.equal(publicView.data.cashSessionId, null);
  assert.equal(publicView.data.cashAcceptedPaise, undefined);
  assert.equal(publicView.data.donationId, undefined);
  const invalid = await request(`/api/controller/${atmId}/cash-events`, { type: 'note_stored' });
  assert.equal(invalid.status, 401);
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, undefined);
});
test('persistent exact duplicate and concurrent close replay change no money or mint reservation', async () => {
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  const close = closeEvent();
  const [one, two] = await Promise.all([post(close), post(close)]);
  assert.deepEqual(one, two);
  const saved = structuredClone(store.records);
  assert.deepEqual(await post(JSON.parse(JSON.stringify(close))), one);
  assert.deepEqual(store.records, saved);
  assert.equal(store.count('donations'), 1);
  assert.equal(store.count('mintJobs'), 1);
});
test('atomic injected commit failure leaves close event, donation, points, job and visit untouched; same close resumes once', async () => {
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  const before = structuredClone(store.records);
  const close = closeEvent();
  store.failNextCommit = true;
  await assert.rejects(post(close), /Injected local atomic commit failure/);
  assert.deepEqual(store.records, before);
  await post(close);
  assert.equal(store.count('donations'), 1);
  assert.equal(store.count('mintJobs'), 1);
  assert.equal(store.read(visitPath).state, 'confirmed');
});
test('duplicate payload mismatch is explicitly rejected, recorded and locks the ATM', async () => {
  const first = makeEvent(1, { type: 'intake_started', data: { inventory: inventory() } });
  await post(first);
  await assert.rejects(post({ ...first, occurredAt: first.occurredAt + 1 }), { code: 'CASH_EVENT_DUPLICATE_MISMATCH' });
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  assert.equal(store.count(`atms/${atmId}/cashRejectedEvents`), 1);
  assert.equal(store.count('donations'), 0);
});
test('sequence gap and stream reset cannot hide a missed note or reopen the ledger', async () => {
  await start();
  await assert.rejects(post(makeEvent(3, { type: 'note_stored', data: { ...note(), route: 'payout' } })), { code: 'CASH_EVENT_SEQUENCE_GAP' });
  const reset = makeEvent(1, { type: 'intake_started', data: { inventory: inventory() } });
  reset.streamId = randomUUID();
  reset.deviceEventId = `${reset.streamId}:1`;
  await assert.rejects(post(reset), { code: 'CASH_STREAM_RESET' });
  assert.equal(store.read(`atms/${atmId}/cashStreams/${streamId}`).lastSequence, 1);
  assert.equal(store.read(visitPath).state, 'reconciling');
});
test('malformed STACKED route and missing close counters reject and preserve reconciliation lock', async () => {
  await start();
  const stacked = makeEvent(2, { type: 'note_stored', data: { ...note(), route: 'payout' } }) as any;
  stacked.data.route = 'cashbox';
  await assert.rejects(post(stacked), { code: 'INVALID_CASH_EVENT' });
  assert.equal(store.read(visitPath).state, 'reconciling');
  const missing = closeEvent(2, 0) as any;
  delete missing.data.inventory.counters.stored;
  await assert.rejects(post(missing), { code: 'INVALID_CASH_EVENT' });
  assert.equal(store.count('donations'), 0);
  await assert.rejects(atm.closeVisit(atmId, cookie, visitId), { code: 'RECONCILIATION_REQUIRED' });
});
test('zero reconciled Done closes with no donation, points or mint and releases active reception', async () => {
  await start();
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent(2, 0));
  assert.equal(store.read(visitPath).state, 'closed');
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, null);
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('mintJobs'), 0);
  assert.equal(store.count('walletTempleTotals'), 0);
});
test('unresolved escrow never creates a donation even when Controller claims disabled and empty', async () => {
  await start();
  await post(makeEvent(2, { type: 'note_escrow', data: { ...note(), decision: 'accept' } }));
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent(3, 0));
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.ok(store.read(sessionPath).ledger.reconciliationReasons.includes('unresolved_escrow'));
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('mintJobs'), 0);
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
});
test('start baseline, close report totals and physical counters cannot be invented or omitted', async () => {
  await stored(1, 1);
  await post(closeEvent(3, 1));
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.count('donations'), 0);
});
test('late new event after zero close is rejected and records locked reconciliation', async () => {
  await start();
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent(2, 0));
  await assert.rejects(post(makeEvent(3, { type: 'note_stored', data: { ...note(), route: 'payout' } })), { code: 'CASH_EVENT_AFTER_CLOSE' });
  assert.equal(store.read(`atms/${atmId}`).cashReconciliationRequired, true);
  assert.equal(store.count('donations'), 0);
});
test('INR session maximum independently stops at ₹400; further physical storage locks, never caps the evidence', async () => {
  await start();
  for (let i = 1; i <= 4; i++) await stored(i, i * 2);
  assert.equal(store.read(visitPath).cashAcceptedPaise, '40000');
  assert.equal(store.read(visitPath).state, 'closing');
  assert.equal(store.read(visitPath).cashCloseReason, 'capacity');
  await stored(5, 10);
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.read(visitPath).cashAcceptedPaise, '50000');
  assert.equal(store.read('cashBudgets/demo').storedPaise, '50000');
  assert.equal(store.count('donations'), 0);
});
test('shared demo ₹1000/10-note budget persists independently of session and stops reception', async () => {
  store.records.set('cashBudgets/demo', { storedPaise: '90000', storedNotes: 9, pendingPaise: '0', pendingNotes: 0 });
  await start();
  await stored();
  assert.equal(store.read('cashBudgets/demo').storedPaise, '100000');
  assert.equal(store.read('cashBudgets/demo').storedNotes, 10);
  assert.equal(store.read(visitPath).cashCloseReason, 'capacity');
  await post(closeEvent());
  await atm.closeVisit(atmId, cookie, visitId);
  assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, false);
  await assert.rejects(atm.createVisit(atmId, cookie, 'cash', randomUUID()), { code: 'CASH_UNAVAILABLE' });
});
test('Interim cumulative demo budget remains audited but does not close or block new reception', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  store.records.set('cashBudgets/demo', { storedPaise: '100000', storedNotes: 10, pendingPaise: '0', pendingNotes: 0 });
  await start();
  await stored();
  assert.equal(store.read('cashBudgets/demo').storedPaise, '110000');
  assert.equal(store.read('cashBudgets/demo').storedNotes, 11);
  assert.equal(store.read(visitPath).state, 'accepting');
  assert.equal(store.read(visitPath).cashCloseReason ?? null, null);
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent());
  await atm.closeVisit(atmId, cookie, visitId);
  assert.equal((await atm.getAtm(atmId, cookie)).cashReceptionAvailable, true);
  const created = await atm.createVisit(atmId, cookie, 'cash', randomUUID());
  assert.ok(created);
});
test('Interim retains the independent ₹400 session limit above cumulative budget', async () => {
  process.env.KALASH_CASH_POLICY = 'interim-ledger';
  store.records.set('cashBudgets/demo', { storedPaise: '100000', storedNotes: 10, pendingPaise: '0', pendingNotes: 0 });
  await start();
  for (let i = 1; i <= 4; i++) await stored(i, i * 2);
  assert.equal(store.read(visitPath).cashCloseReason, 'capacity');
  assert.equal(store.read(visitPath).cashAcceptedPaise, '40000');
  assert.equal(store.read('cashBudgets/demo').storedPaise, '140000');
  assert.equal(store.read(visitPath).state, 'closing');
});
test('Controller session deadline GET persists a stop, never confirmation, and UI disables acceptance', async () => {
  store.records.set(visitPath, { ...store.read(visitPath), cashDeadline: Date.now() - 1 });
  const session = await cash.getControllerCashSession(atmId, auth);
  assert.equal(session.session?.state, 'closing');
  assert.equal(session.session?.closeReason, 'deadline');
  assert.equal(store.read(visitPath).cashCloseRequested, true);
  assert.equal((await atm.getVisit(visitId, 'temple-01', wallet.address)).cashAcceptanceEnabled, false);
  assert.equal(store.count('donations'), 0);
});
test('used consent binding and matching ATM are mandatory even for authenticated Controller', async () => {
  store.records.set('cashConsentChallenges/consent', { ...store.read('cashConsentChallenges/consent'), wallet: other.address });
  await assert.rejects(start(), { code: 'CASH_CONSENT_REQUIRED' });
  assert.equal(store.count(`atms/${atmId}/cashEvents`), 0);
});
test('local signature challenge and command lifecycle use real ATM service logic before event Ready', async () => {
  store.records.set(`atms/${atmId}`, { ...store.read(`atms/${atmId}`), activeVisitId: null });
  const created = await atm.createVisit(atmId, cookie, 'cash', randomUUID());
  const id = created.visit!.id;
  const challenge = await atm.createCashConsentChallenge(id, wallet.address, 'temple-01');
  assert.ok(challenge.message.includes(`Visit: ${id}`));
  const signature = await wallet.signMessage({ message: challenge.message });
  const claimed = await atm.claimCashVisit(id, wallet.address, 'temple-01', challenge.nonce, signature);
  assert.equal(claimed.state, 'awaiting_device');
  const available = await atm.getControllerCashCommand(atmId, auth);
  assert.ok(available.command);
  for (const state of ['received', 'validated', 'dispatching', 'observed', 'reported']) {
    await atm.reportControllerCashCommand(atmId, auth, {
      commandId: available.command.commandId, state,
      ...(state === 'observed' ? { deviceState: 'ACCEPTING', observedAt: Date.now() } : {}),
    });
  }
  assert.equal((await atm.getVisit(id, 'temple-01', wallet.address)).state, 'accepting');
  const ready = await cash.getControllerCashSession(atmId, auth);
  assert.equal(ready.session?.visitId, id);
});
test('a valid-looking unsolicited Done close is ledger evidence, not a user stop or donation', async () => {
  await start();
  await stored();
  await post(closeEvent());
  assert.equal(store.count('donations'), 0);
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.ok(store.read(sessionPath).ledger.reconciliationReasons.includes('done_not_requested'));
});
test('late STORED after a returned note never revives cash credit or reaches mint', async () => {
  await start();
  await post(makeEvent(2, { type: 'note_escrow', data: { ...note(), decision: 'accept' } }));
  await post(makeEvent(3, { type: 'note_returned', data: note() }));
  await post(makeEvent(4, { type: 'note_stored', data: { ...note(), route: 'payout' } }));
  assert.equal(store.read(sessionPath).ledger.notes[0].credited, false);
  assert.equal(store.read(visitPath).cashAcceptedPaise, '10000');
  await post(closeEvent(5));
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('mintJobs'), 0);
});
test('reported close total mismatch prevents atomic settlement despite matching physical balances', async () => {
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  const close = closeEvent();
  if (close.type === 'intake_closed') close.data.creditedPaise = '20000';
  await post(close);
  assert.ok(store.read(sessionPath).ledger.reconciliationReasons.includes('credit_mismatch'));
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('walletTempleTotals'), 0);
});
test('demo note-count ceiling is independent of amount and cannot be bypassed with small denominations', async () => {
  store.records.set('cashBudgets/demo', { storedPaise: '9000', storedNotes: 9, pendingPaise: '0', pendingNotes: 0 });
  await start();
  await stored();
  assert.equal(store.read('cashBudgets/demo').storedPaise, '19000');
  assert.equal(store.read('cashBudgets/demo').storedNotes, 10);
  assert.equal(store.read(visitPath).cashCloseReason, 'capacity');
  await stored(2, 4);
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.read('cashBudgets/demo').storedNotes, 11);
  assert.equal(store.count('donations'), 0);
});
test('persisted stream sequence continues between sessions and even clean closure never authorizes a reset', async () => {
  await start();
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent(2, 0));
  const nextVisit = 'd'.repeat(64);
  const nextSession = randomUUID();
  store.records.set(`visits/${nextVisit}`, {
    ...store.read(visitPath), id: nextVisit, cashSessionId: nextSession, state: 'accepting',
    cashCloseRequested: false, cashCloseReason: null, cashConsentChallenge: 'next-consent',
  });
  store.records.set(`atms/${atmId}`, { ...store.read(`atms/${atmId}`), activeVisitId: nextVisit });
  store.records.set('cashConsentChallenges/next-consent', {
    ...store.read('cashConsentChallenges/consent'), visitId: nextVisit, cashSessionId: nextSession,
  });
  store.records.set(`controllerCommands/cash-start-${nextSession}`, {
    ...store.read(`controllerCommands/cash-start-${cashSessionId}`), visitId: nextVisit, cashSessionId: nextSession,
  });
  const next = { ...makeEvent(3, { type: 'intake_started', data: { inventory: inventory() } }), visitId: nextVisit, cashSessionId: nextSession };
  assert.equal((await post(next)).sequence, 3);
  const restart = randomUUID();
  await assert.rejects(post({ ...next, streamId: restart, sequence: 1, deviceEventId: `${restart}:1` }), { code: 'CASH_STREAM_RESET' });
  assert.equal(store.read(`visits/${nextVisit}`).state, 'reconciling');
});
test('a colliding mint reservation fails closed without partial points or donation writes', async () => {
  await start();
  await stored();
  await atm.doneCashVisit(atmId, cookie, visitId);
  const before = structuredClone(store.records);
  const close = closeEvent();
  await post(close);
  const donationId = store.read(visitPath).donationId;
  store.records = before;
  store.records.set(`mintJobs/${donationId}`, { status: 'reserved', donationId });
  await assert.rejects(post(close), { code: 'CASH_SETTLEMENT_CONFLICT' });
  assert.equal(store.count('donations'), 0);
  assert.equal(store.count('walletTempleTotals'), 0);
  assert.equal(store.read(`atms/${atmId}/cashEvents/${streamId}:4`), undefined);
});
test('reordered event times are explicitly rejected and persisted as reconciliation evidence', async () => {
  const first = makeEvent(1, { type: 'intake_started', data: { inventory: inventory() } });
  await post(first);
  const next = makeEvent(2, { type: 'note_escrow', data: { ...note(), decision: 'accept' } });
  await assert.rejects(post({ ...next, occurredAt: first.occurredAt - 1 }), { code: 'CASH_EVENT_TIME_ORDER' });
  assert.equal(store.count(`atms/${atmId}/cashRejectedEvents`), 1);
  assert.equal(store.count('donations'), 0);
});
test('Done never downgrades the integrated needs_reconciliation state to closing or confirmation', async () => {
  await start();
  store.records.set(visitPath, { ...store.read(visitPath), state: 'needs_reconciliation' });
  await atm.doneCashVisit(atmId, cookie, visitId);
  assert.equal(store.read(visitPath).state, 'needs_reconciliation');
  await atm.doneOwnedCashVisit(visitId, wallet.address, 'temple-01');
  assert.equal(store.read(visitPath).state, 'needs_reconciliation');
  await post(closeEvent(2, 0));
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.equal(store.count('donations'), 0);
  assert.equal(store.read(`atms/${atmId}`).activeVisitId, visitId);
});
function idleReadinessReport() {
  const observedAt = Date.now() - 1000;
  return {
    commandId: `cash-start-${cashSessionId}`, state: 'observed', deviceState: 'IDLE', observedAt,
    readinessEvidence: {
      version: 'itl-idle-after-enable-v1', commandId: `cash-start-${cashSessionId}`, cashSessionId, deviceId: 'local-double',
      disabledObservedAt: observedAt - 3000, enableDispatchedAt: observedAt - 2000, enableAcknowledgedAt: observedAt - 1000,
      idleObservedAt: observedAt, disabledRawSequence: 4, rawSequence: 5, deviceStateCode: 5,
      manualEscrow: true, routesVerified: true, escrowEmpty: true, deviceHealthy: true,
      baseline: inventory(), inventory: inventory(),
    },
  };
}
function awaitingObservedStart(report: ReturnType<typeof idleReadinessReport>) {
  const commandPath = `controllerCommands/cash-start-${cashSessionId}`;
  store.records.set(commandPath, {
    ...store.read(commandPath), state: 'dispatching', createdAt: report.readinessEvidence.disabledObservedAt - 1000,
  });
  store.records.set(visitPath, { ...store.read(visitPath), state: 'awaiting_device', cashDeadline: null });
}
test('bare IDLE, missing readback fields and wrong command/device/time never establish Ready', async () => {
  const initial = idleReadinessReport();
  awaitingObservedStart(initial);
  const { readinessEvidence, ...bare } = initial;
  await assert.rejects(atm.reportControllerCashCommand(atmId, auth, bare), { code: 'INVALID_CASH_READINESS_EVIDENCE' });
  for (const mutate of [
    (proof: any) => { delete proof.manualEscrow; },
    (proof: any) => { proof.escrowEmpty = false; },
    (proof: any) => { proof.deviceId = 'different-device'; },
    (proof: any) => { proof.idleObservedAt++; },
    (proof: any) => { proof.disabledObservedAt = store.read(`controllerCommands/cash-start-${cashSessionId}`).createdAt - 30001; },
    (proof: any) => { proof.inventory.counters.stored = 1; },
    (proof: any) => { proof.rawSequence = proof.disabledRawSequence; },
  ]) {
    const changed = structuredClone(readinessEvidence);
    mutate(changed);
    await assert.rejects(atm.reportControllerCashCommand(atmId, auth, { ...bare, readinessEvidence: changed }),
      { code: 'INVALID_CASH_READINESS_EVIDENCE' });
    assert.equal(store.read(visitPath).state, 'awaiting_device');
    assert.equal(store.read(visitPath).cashDeadline, null);
  }
});
test('IDLE proof permits thirty-second Controller clock tolerance, not stale or reordered evidence', async () => {
  const report = idleReadinessReport();
  awaitingObservedStart(report);
  const path = `controllerCommands/cash-start-${cashSessionId}`;
  store.records.set(path, { ...store.read(path), createdAt: report.readinessEvidence.disabledObservedAt + 30001 });
  await assert.rejects(atm.reportControllerCashCommand(atmId, auth, report), { code: 'INVALID_CASH_READINESS_EVIDENCE' });
  store.records.set(path, { ...store.read(path), createdAt: report.readinessEvidence.disabledObservedAt + 30000 });
  await atm.reportControllerCashCommand(atmId, auth, report);
  assert.equal(store.read(visitPath).state, 'accepting');
});
test('complete immutable IDLE wire report -> Ready -> note -> Done -> reconciled atomic mint reservation', async (t) => {
  const report: ReturnType<typeof idleReadinessReport> = JSON.parse(readFileSync(
    process.env.KALASH_CASH_READINESS_WIRE ?? new URL('fixtures/cash-idle-readiness-wire.synthetic.json', import.meta.url), 'utf8',
  ));
  t.mock.timers.enable({ apis: ['Date'], now: report.observedAt + 100 });
  seed();
  t.diagnostic('Consumed actual C# serialized HTTP report using controlled local clock; no hardware or live Firestore.');
  awaitingObservedStart(report);
  const response = await request(`/api/controller/${atmId}/commands/${report.commandId}`, report, { Authorization: auth });
  assert.equal(response.status, 200);
  assert.equal(store.read(visitPath).state, 'accepting');
  assert.equal(store.read(visitPath).cashDeadline, report.observedAt + 240000);
  assert.equal(store.read(visitPath).cashAcceptanceMs, 240000);
  assert.equal(store.read(`controllerCommands/${report.commandId}`).deviceState, 'IDLE');
  assert.deepEqual(store.read(`controllerCommands/${report.commandId}`).readinessEvidence, report.readinessEvidence);
  assert.deepEqual(await atm.reportControllerCashCommand(atmId, auth, report), { accepted: true, state: 'observed' });
  await assert.rejects(atm.reportControllerCashCommand(atmId, auth, {
    ...report, state: 'reported', readinessEvidence: { ...report.readinessEvidence, deviceId: 'changed-device' },
  }), { code: 'CASH_COMMAND_OBSERVATION_CONFLICT' });
  await atm.reportControllerCashCommand(atmId, auth, { ...report, state: 'reported' });
  await start();
  t.mock.timers.tick(1);
  await stored();
  t.mock.timers.tick(1);
  await atm.doneCashVisit(atmId, cookie, visitId);
  await post(closeEvent());
  assert.equal(store.read(visitPath).state, 'confirmed');
  assert.equal(store.count('donations'), 1);
  assert.equal(store.count('mintJobs'), 1);
});
test('intake baseline differing from IDLE-ready readback remains locked with no donation', async () => {
  const report = idleReadinessReport();
  awaitingObservedStart(report);
  await atm.reportControllerCashCommand(atmId, auth, report);
  await post(makeEvent(1, { type: 'intake_started', data: { inventory: inventory(1) } }));
  assert.equal(store.read(visitPath).state, 'reconciling');
  assert.ok(store.read(sessionPath).ledger.reconciliationReasons.includes('readiness_baseline_mismatch'));
  assert.equal(store.count('donations'), 0);
});
