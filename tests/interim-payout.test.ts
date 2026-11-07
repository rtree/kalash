import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeAbiParameters, encodeEventTopics, erc20Abi, TransactionReceiptNotFoundError,
  type Hex, type Log,
} from 'viem';
import { CASH_DENOMINATIONS, type CashInventory, type CashLedger } from '../src/cash.ts';
import { cashFeeAbi, type CashFeeInvoice } from '../src/payout.ts';
import { USDC } from '../src/shared.ts';

class LocalStore {
  records = new Map<string, any>();
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
      path,
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
      this.records = next;
      return result;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

const previousPolicy = process.env.KALASH_CASH_POLICY;
process.env.KALASH_CASH_POLICY = 'interim-ledger';
const store = new LocalStore();
const adminWallet = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}` as Hex);
const originalReadFile = readFileSync;
mock.module('node:fs', { namedExports: {
  readFileSync: (...args: Parameters<typeof readFileSync>) => args[0] === 'config/temple-admins.public.json'
    ? JSON.stringify({ chainId: 84532, templeWalletAdmins: { 'temple-01': adminWallet.address } })
    : originalReadFile(...args),
} });

let feeReceipt: { status: 'success' | 'reverted'; to: Hex; from: Hex; blockHash: Hex; blockNumber: bigint; logs: Log[] } | null = null;
const atmId = 'atm-01';
const cashSessionId = '20000000-0000-4000-8000-000000000001';
const deviceId = 'interim-device';
const controllerToken = 'c'.repeat(64);
mock.module('../src/server/config.ts', { namedExports: {
  db: store, origin: 'https://kalash.example', project: 'interim-payout-tests', auth: {}, signer: {},
  minter: { signTypedData: async () => '0x1234' },
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
  deployment: { stamp: '0x0000000000000000000000000000000000000001',
    vault: '0x0000000000000000000000000000000000000002',
    cashFeeVault: '0x0000000000000000000000000000000000000003' },
  publicConfig: {},
} });

const payout = await import('../src/server/payout.ts');
const atmService = await import('../src/server/atm.ts');
const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');

function inventory(count: number): CashInventory {
  return {
    levels: CASH_DENOMINATIONS.map((valuePaise) => ({ valuePaise, payout: valuePaise === '10000' ? count : 0, cashbox: 3 })),
    counters: { stored: 1, stacked: 0, dispensed: 0, transferredToStack: 0 },
  };
}

function seed(options: { payoutNotes?: number; historicalMismatch?: boolean; dispensedPaise?: string } = {}) {
  store.records.clear();
  feeReceipt = null;
  const now = Date.now();
  const baseline = inventory(0);
  const ledger: CashLedger = {
    baseline,
    notes: [{ noteKey: 'stored-note-1', valuePaise: '10000', currency: 'INR',
      decision: 'accept', stored: true, returned: false, credited: true }],
    reconciliationReasons: options.historicalMismatch ? ['credit_mismatch'] : [],
    closed: true,
  };
  store.records.set(`atms/${atmId}`, {
    id: atmId, name: 'Local ATM', templeId: 'temple-01', enabled: true, cashEnabled: true,
    credentialHash: credentialHash(controllerToken), cashReconciliationRequired: options.historicalMismatch === true,
    cashHistoricalReconciliationOnly: options.historicalMismatch === true,
    controllerHealth: {
      sequence: 1, receivedAt: now, usbConnected: true, connectionOpen: true,
      deviceStarted: true, routesVerified: true, pollerOwned: true, deviceId,
    },
    payoutInventory: { observedAt: now, deviceId, deviceState: 'DISABLED', escrowEmpty: true,
      inventory: inventory(options.payoutNotes ?? 2), rawSequence: 4 },
  });
  store.records.set(`cashSessions/${cashSessionId}`, {
    atmId, templeId: 'temple-01', visitId: 'a'.repeat(64), cashSessionId, ledger,
  });
  store.records.set(`visits/${'a'.repeat(64)}`, {
    id: 'a'.repeat(64), atmId, templeId: 'temple-01', cashSessionId, state: 'reconciling',
  });
  store.records.set(`cashPayoutAccounts/${atmId}`, {
    dispensedPaise: options.dispensedPaise ?? '0',
  });
}

function seedPendingReturnAudit() {
  seed({ historicalMismatch: true });
  const visitId = 'a'.repeat(64);
  const sessionPath = `cashSessions/${cashSessionId}`;
  const session = store.records.get(sessionPath);
  session.closeEvidence = { type: 'intake_closed', occurredAt: Date.now() - 1_000 };
  session.ledger.notes.push({ noteKey: 'pending-return', valuePaise: '10000', currency: 'INR',
    decision: 'return', stored: false, returned: false, credited: false });
  session.ledger.reconciliationReasons = ['unresolved_escrow', 'controller_fault'];
  store.records.set(sessionPath, session);
  store.records.set(`visits/${visitId}`, {
    id: visitId, atmId, templeId: 'temple-01', cashSessionId, mode: 'cash', state: 'reconciling',
    reconciliationReasons: ['unresolved_escrow', 'controller_fault'],
  });
  store.records.set(`controllerCommands/cash-start-${cashSessionId}`, {
    commandId: `cash-start-${cashSessionId}`, type: 'start_cash', state: 'reported',
    atmId, templeId: 'temple-01', visitId, cashSessionId,
  });
  store.records.set(`atms/${atmId}`, {
    ...store.records.get(`atms/${atmId}`), activeVisitId: visitId, cashPhysicalReconciliationRequired: true,
    cashHistoricalReconciliationOnly: false,
  });
}

function feeLogs(invoice: CashFeeInvoice, hash: Hex): Log[] {
  const blockHash = `0x${'d'.repeat(64)}` as Hex;
  const common = { blockHash, blockNumber: 1n, transactionHash: hash, transactionIndex: 0, removed: false };
  const topics = (values: ReturnType<typeof encodeEventTopics>): Log['topics'] => {
    const entries = values.map((value) => {
      if (typeof value !== 'string') throw new Error('Only concrete event topics are allowed in this fixture.');
      return value;
    });
    const first = entries.shift();
    assert.ok(first);
    return [first, ...entries];
  };
  return [
    { ...common, address: invoice.vault, logIndex: 0,
      topics: topics(encodeEventTopics({ abi: cashFeeAbi, eventName: 'FeePaid',
        args: { invoiceId: invoice.invoiceId, payer: invoice.payer, templeId: invoice.templeKey } })),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(invoice.amount), invoice.recipient]) },
    { ...common, address: USDC, logIndex: 1,
      topics: topics(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer',
        args: { from: invoice.payer, to: invoice.recipient } })),
      data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(invoice.amount)]) },
  ];
}

async function createAndPayInvoice() {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  const hash = `0x${'e'.repeat(64)}` as Hex;
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  feeReceipt = { status: 'success', to: invoice.vault, from: adminWallet.address,
    blockHash: `0x${'d'.repeat(64)}`, blockNumber: 1n, logs: feeLogs(invoice, hash) };
  const paid = await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, { txHash: hash });
  return { invoice, paid };
}

async function approveActualPayout() {
  const requestId = randomUUID();
  const approval = await payout.createPayoutApproval(atmId, { requestId }, adminWallet.address);
  const context = await payout.getPayoutApproval(approval.approvalId);
  return payout.approvePayout(atmId, adminWallet.address, approval.approvalId,
    { signature: await adminWallet.signMessage({ message: context.message }) });
}

beforeEach(() => seed({ historicalMismatch: true }));
after(() => {
  if (previousPolicy === undefined) delete process.env.KALASH_CASH_POLICY;
  else process.env.KALASH_CASH_POLICY = previousPolicy;
});

test('Interim fee is 3% of closed recognized stored ledger cash, keyed by cash session without fabricating a donation', async () => {
  const { invoice, paid } = await createAndPayInvoice();
  assert.equal(invoice.cashPaise, '10000');
  assert.equal(invoice.amount, '30000');
  assert.deepEqual(invoice.donationIds, []);
  assert.deepEqual(invoice.sourceKeys, [`cash-session:${cashSessionId}`]);
  assert.equal(paid.status, 'paid');
  assert.equal(store.records.has(`donations/${cashSessionId}`), false);
  assert.deepEqual(store.records.get(`cashFeeCoverage/cash-session:${cashSessionId}`), {
    invoiceId: invoice.invoiceId, atmId, txHash: `0x${'e'.repeat(64)}`,
  });
  const state = await payout.getTemplePayout(atmId, adminWallet.address);
  assert.equal(state.cashPolicy, 'interim-ledger');
  assert.equal(state.recognizedCashPaise, '10000');
  assert.equal(state.actualPayoutPaise, '20000');
  assert.equal(state.differencePaise, '10000');
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }),
    { code: 'NO_UNSETTLED_CASH' });
});

test('zero-credit historical failed starts do not block recognized-cash fees or mutate their evidence', async () => {
  const zeroSessionId = '2a364965-289e-4bff-abdf-e7af7cab0c3e';
  const zeroVisitId = 'b'.repeat(64);
  const zeroPath = `cashSessions/${zeroSessionId}`;
  const legacy = {
    atmId, cashSessionId: zeroSessionId, visitId: zeroVisitId,
    ledger: { baseline: null, notes: [], closed: true,
      reconciliationReasons: ['ready_not_observed', 'prior_reconciliation_required',
        'start_command_not_observed', 'missing_baseline', 'controller_fault'] },
  };
  store.records.set(zeroPath, structuredClone(legacy));
  store.records.set(`visits/${zeroVisitId}`, {
    id: zeroVisitId, atmId, templeId: 'temple-01', cashSessionId: zeroSessionId, state: 'closed',
  });
  const state = await payout.getTemplePayout(atmId, adminWallet.address);
  assert.equal(state.recognizedCashPaise, '10000');
  const { invoice } = await createAndPayInvoice();
  assert.equal(invoice.cashPaise, '10000');
  assert.deepEqual(invoice.sourceKeys, [`cash-session:${cashSessionId}`]);
  assert.deepEqual(store.records.get(zeroPath), legacy);
});

test('positive-credit operationally unresolved ledgers still cannot fund Interim fee settlement', async () => {
  const session = store.records.get(`cashSessions/${cashSessionId}`);
  session.ledger.reconciliationReasons = ['controller_fault'];
  const before = structuredClone(session);
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }),
    { code: 'UNRECONCILED_CASH_SOURCE' });
  assert.deepEqual(store.records.get(`cashSessions/${cashSessionId}`), before);
});

test('relayed wallet fee receipt uses exact vault and payer events rather than outer sender or target', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  const hash = `0x${'e'.repeat(64)}` as Hex;
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  feeReceipt = { status: 'success', to: `0x${'1'.repeat(40)}`, from: `0x${'2'.repeat(40)}`,
    blockHash: `0x${'d'.repeat(64)}`, blockNumber: 1n, logs: feeLogs(invoice, hash) };
  const paid = await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, { txHash: hash });
  assert.equal(paid.status, 'paid');
  assert.equal((await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, {})).status, 'paid');
  const result = await approveActualPayout();
  assert.equal(store.records.get(`cashPayouts/${result.payoutId}`).command.amountPaise, '20000');
});

test('relayed receipt cannot replace the payer bound by FeePaid and the actual USDC transfer', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  const hash = `0x${'e'.repeat(64)}` as Hex;
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  feeReceipt = { status: 'success', to: `0x${'1'.repeat(40)}`, from: `0x${'2'.repeat(40)}`,
    blockHash: `0x${'d'.repeat(64)}`, blockNumber: 1n,
    logs: feeLogs({ ...invoice, payer: `0x${'3'.repeat(40)}` }, hash) };
  await assert.rejects(payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, { txHash: hash }),
    { code: 'FEE_EVENT_MISMATCH' });
  assert.equal(store.records.get(`cashFeeInvoices/${invoice.invoiceId}`).status, 'submitted');
  assert.equal(store.records.has(`cashFeeCoverage/cash-session:${cashSessionId}`), false);
});

test('canonical fee coverage permits one signed full actual payout despite ledger mismatch or prior dispensed excess', async () => {
  await createAndPayInvoice();
  const payoutResult = await approveActualPayout();
  const record = store.records.get(`cashPayouts/${payoutResult.payoutId}`);
  assert.equal(record.command.amountPaise, '20000');
  assert.equal(BigInt(record.command.amountPaise), 20000n);
  assert.equal(record.approver, adminWallet.address);

  seed({ historicalMismatch: true, payoutNotes: 1, dispensedPaise: '20000' });
  await createAndPayInvoice();
  const afterPriorDispensing = await approveActualPayout();
  assert.equal(store.records.get(`cashPayouts/${afterPriorDispensing.payoutId}`).command.amountPaise, '10000');
});

test('Interim payout rejects an empty Payout compartment even after fee coverage', async () => {
  seed({ historicalMismatch: true, payoutNotes: 0 });
  await createAndPayInvoice();
  await assert.rejects(approveActualPayout(), { code: 'NO_CASH_TO_PAYOUT' });
});

test('Open Fee Settlement starts already-paid full payout without QR or a second signature', async () => {
  const { invoice } = await createAndPayInvoice();
  const result = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID() });
  const record = store.records.get(`cashPayouts/${result.payoutId}`);
  assert.equal(record.command.amountPaise, '20000');
  assert.equal(record.state, 'pending');
  assert.equal(record.approver, adminWallet.address);
  assert.equal(store.records.get(`cashFeeInvoices/${invoice.invoiceId}`).status, 'paid');
  assert.equal((await payout.getPayoutCommand(atmId, `Bearer ${controllerToken}`)).command?.payoutId, result.payoutId);
});

test('fee Send txHash starts payout with no receipt while recording risk, not fabricated paid evidence', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  const hash = `0x${'e'.repeat(64)}` as Hex;
  const result = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID(), txHash: hash });
  assert.equal(store.records.get(`cashPayouts/${result.payoutId}`).command.amountPaise, '20000');
  const current = store.records.get(`cashFeeInvoices/${invoice.invoiceId}`);
  assert.equal(current.status, 'submitted');
  assert.equal(current.txHash, hash);
  assert.ok(current.settlementRiskAcceptedAt);
  assert.equal(current.paidBlock, undefined);
  assert.equal(store.records.get(`cashFeeCoverage/cash-session:${cashSessionId}`).settlementBasis, 'submitted_at_kalash_risk');
  assert.equal([...store.records.keys()].some((key) => key.startsWith('cashFeeChainEvents/')), false);
  await assert.rejects(approveActualPayout(), { code: 'ATM_BUSY_OR_LOCKED' });
});

test('canonical verification later upgrades risk coverage without sending a second payout', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  const hash = `0x${'e'.repeat(64)}` as Hex;
  const first = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID(), txHash: hash });
  feeReceipt = { status: 'success', to: invoice.vault, from: adminWallet.address,
    blockHash: `0x${'d'.repeat(64)}`, blockNumber: 1n, logs: feeLogs(invoice, hash) };
  const paid = await payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, {});
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidBlock, '1');
  assert.deepEqual(store.records.get(`cashFeeCoverage/cash-session:${cashSessionId}`),
    { invoiceId: invoice.invoiceId, atmId, txHash: hash });
  const repeat = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID() });
  assert.deepEqual(repeat, first);
  assert.equal([...store.records.keys()].filter((key) => key.startsWith('cashPayouts/')).length, 1);
});

test('a reverted fee receipt stays unresolved but cannot revoke or blindly retry risk-authorized payout', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  const hash = `0x${'e'.repeat(64)}` as Hex;
  const first = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID(), txHash: hash });
  feeReceipt = { status: 'reverted', to: invoice.vault, from: adminWallet.address,
    blockHash: `0x${'d'.repeat(64)}`, blockNumber: 1n, logs: [] };
  await assert.rejects(payout.verifyCashFee(atmId, adminWallet.address, invoice.invoiceId, {}), { code: 'FEE_RECEIPT_MISMATCH' });
  assert.equal(store.records.get(`cashFeeInvoices/${invoice.invoiceId}`).status, 'submitted');
  assert.deepEqual(await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID() }), first);
});

test('concurrent settlement clicks and retry after unknown or completed result use one immutable command', async () => {
  const { invoice } = await createAndPayInvoice();
  const body = () => ({ invoiceId: invoice.invoiceId, requestId: randomUUID() });
  const results = await Promise.all([
    payout.openFeeSettlement(atmId, adminWallet.address, body()),
    payout.openFeeSettlement(atmId, adminWallet.address, body()),
  ]);
  assert.deepEqual(results[0], results[1]);
  const result = results[0]!;
  const record = store.records.get(`cashPayouts/${result.payoutId}`);
  record.state = 'unknown';
  assert.deepEqual(await payout.openFeeSettlement(atmId, adminWallet.address, body()),
    { payoutId: result.payoutId, state: 'unknown' });
  assert.equal((await payout.getPayoutCommand(atmId, `Bearer ${controllerToken}`)).command, null);
  record.state = 'reported';
  const atm = store.records.get(`atms/${atmId}`);
  atm.activePayoutId = null;
  atm.lastPayoutId = result.payoutId;
  assert.deepEqual(await payout.openFeeSettlement(atmId, adminWallet.address, body()),
    { payoutId: result.payoutId, state: 'reported' });
  assert.equal([...store.records.keys()].filter((key) => key.startsWith('cashPayouts/')).length, 1);
});

test('unknown Send without txHash and unsubmitted wallet approval cannot start payout', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  const request = { invoiceId: invoice.invoiceId, requestId: randomUUID(), txHash: `0x${'e'.repeat(64)}` };
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address, request), { code: 'FEE_SUBMISSION_REQUIRED' });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID() }), { code: 'FEE_SUBMISSION_REQUIRED' });
  assert.equal([...store.records.keys()].some((key) => key.startsWith('cashPayouts/')), false);
});

test('direct settlement preserves administrator, invoice hash, active reception and fresh device gates', async () => {
  const { invoice } = await createAndPayInvoice();
  const body = { invoiceId: invoice.invoiceId, requestId: randomUUID() };
  const other = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}` as Hex);
  await assert.rejects(payout.openFeeSettlement(atmId, other.address, body), { code: 'TEMPLE_ADMIN_REQUIRED' });
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address,
    { ...body, txHash: `0x${'f'.repeat(64)}` }), { code: 'FEE_HASH_CONFLICT' });
  const atm = store.records.get(`atms/${atmId}`);
  atm.activeVisitId = 'a'.repeat(64);
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address, body), { code: 'ATM_BUSY_OR_LOCKED' });
  atm.activeVisitId = null;
  atm.payoutInventory.observedAt = Date.now() - 31_000;
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address, body), { code: 'PAYOUT_INVENTORY_UNVERIFIED' });
  assert.equal(store.records.get(`cashFeeInvoices/${invoice.invoiceId}`).settlementPayoutRequestId, undefined);
});

test('strict mode cannot use submitted-fee risk settlement or unsigned direct payout', async () => {
  const { invoice } = await createAndPayInvoice();
  process.env.KALASH_CASH_POLICY = 'strict';
  try {
    await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address,
      { invoiceId: invoice.invoiceId, requestId: randomUUID() }), { code: 'DIRECT_SETTLEMENT_DISABLED' });
  } finally { process.env.KALASH_CASH_POLICY = 'interim-ledger'; }
});

test('risk-covered cash is never charged again, while newly recognized cash gets a new invoice and payout', async () => {
  const invoice = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, invoice.invoiceId);
  const firstHash = `0x${'e'.repeat(64)}` as Hex;
  const first = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: invoice.invoiceId, requestId: randomUUID(), txHash: firstHash });
  const record = store.records.get(`cashPayouts/${first.payoutId}`);
  record.state = 'reported';
  const atm = store.records.get(`atms/${atmId}`);
  atm.activePayoutId = null;
  atm.lastPayoutId = first.payoutId;
  assert.equal((await payout.getTemplePayout(atmId, adminWallet.address)).unsettledCashPaise, '0');
  await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }),
    { code: 'NO_UNSETTLED_CASH' });

  const newSessionId = randomUUID();
  const newVisitId = 'b'.repeat(64);
  const oldSession = store.records.get(`cashSessions/${cashSessionId}`);
  store.records.set(`cashSessions/${newSessionId}`, { ...structuredClone(oldSession), cashSessionId: newSessionId, visitId: newVisitId });
  store.records.set(`visits/${newVisitId}`, { id: newVisitId, atmId, templeId: 'temple-01', cashSessionId: newSessionId, state: 'closed' });
  assert.equal((await payout.getTemplePayout(atmId, adminWallet.address)).unsettledCashPaise, '10000');
  const next = await payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() });
  assert.equal(next.cashPaise, '10000');
  assert.deepEqual(next.sourceKeys, [`cash-session:${newSessionId}`]);
  await payout.recordCashFeeSubmission(atmId, adminWallet.address, next.invoiceId);
  await assert.rejects(payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: next.invoiceId, requestId: randomUUID(), txHash: firstHash }), { code: 'FEE_ALREADY_USED' });
  const second = await payout.openFeeSettlement(atmId, adminWallet.address,
    { invoiceId: next.invoiceId, requestId: randomUUID(), txHash: `0x${'f'.repeat(64)}` });
  assert.notEqual(second.payoutId, first.payoutId);
  assert.equal(store.records.get(`cashPayouts/${second.payoutId}`).command.amountPaise, '20000');
  assert.equal(store.records.get(`cashFeeInvoices/${invoice.invoiceId}`).status, 'submitted');
});

test('strict policy does not use the Interim closed-ledger fallback', async () => {
  const configured = process.env.KALASH_CASH_POLICY;
  delete process.env.KALASH_CASH_POLICY;
  try {
    seed({ historicalMismatch: true });
    await assert.rejects(payout.createCashFeeInvoice(atmId, adminWallet.address, { requestId: randomUUID() }),
      { code: 'NO_UNSETTLED_CASH' });
  } finally {
    if (configured === undefined) delete process.env.KALASH_CASH_POLICY;
    else process.env.KALASH_CASH_POLICY = configured;
  }
});

test('active historical readback stores bound audit evidence without editing a pending note or ledger', async () => {
  seedPendingReturnAudit();
  const before = structuredClone(store.records.get(`cashSessions/${cashSessionId}`).ledger);
  const report = { observedAt: Date.now(), deviceId, deviceState: 'DISABLED' as const, escrowEmpty: true as const,
    inventory: inventory(2), rawSequence: 5 };
  assert.deepEqual(await payout.reportPayoutInventory(atmId, `Bearer ${controllerToken}`, report), { accepted: true });
  const atm = store.records.get(`atms/${atmId}`);
  assert.deepEqual(atm.cashAuditReadback, { visitId: 'a'.repeat(64), cashSessionId, report });
  assert.deepEqual(store.records.get(`cashSessions/${cashSessionId}`).ledger, before);
  assert.equal(atm.cashPhysicalReconciliationRequired, true);
});

test('ADC retirement accepts the real legacy reason set only after fresh bound readback without fabricating a note outcome', async () => {
  seedPendingReturnAudit();
  const visitId = 'a'.repeat(64);
  const sessionPath = `cashSessions/${cashSessionId}`;
  const visitPath = `visits/${visitId}`;
  const legacyReasons = [
    'unexpected_device_state_event', 'unexpected_device_state', 'prior_reconciliation_required',
    'close_observation_timeout', 'unresolved_escrow',
  ];
  const session = store.records.get(sessionPath);
  const pendingReturn = session.ledger.notes.at(-1);
  session.ledger.notes = [pendingReturn];
  session.ledger.reconciliationReasons = legacyReasons;
  const physicalInventory: CashInventory = {
    levels: CASH_DENOMINATIONS.map((valuePaise) => ({
      valuePaise,
      payout: valuePaise === '10000' ? 3 : 0,
      cashbox: valuePaise === '1000' || valuePaise === '2000' ? 2 : valuePaise === '20000' ? 1 : 0,
    })),
    counters: { stored: 57, stacked: 2, dispensed: 53, transferredToStack: 1 },
  };
  session.ledger.baseline = physicalInventory;
  store.records.set(sessionPath, session);
  const visit = store.records.get(visitPath);
  delete visit.reconciliationReason;
  delete visit.reconciliationReasons;
  visit.cashAcceptedPaise = '0';
  store.records.set(visitPath, visit);
  const atm = store.records.get(`atms/${atmId}`);
  atm.payoutInventory = { ...atm.payoutInventory, inventory: physicalInventory, rawSequence: 5 };
  store.records.set(`atms/${atmId}`, atm);
  const before = structuredClone(session.ledger);

  const report = { observedAt: Date.now(), deviceId, deviceState: 'DISABLED' as const,
    escrowEmpty: true as const, inventory: physicalInventory, rawSequence: 6 };
  await payout.reportPayoutInventory(atmId, `Bearer ${controllerToken}`, report);
  assert.equal(await atmService.retireHistoricalCashAfterReadback(atmId, visitId), true);

  const retiredAtm = store.records.get(`atms/${atmId}`);
  const retiredVisit = store.records.get(visitPath);
  const retiredLedger = store.records.get(sessionPath).ledger;
  assert.equal(retiredAtm.activeVisitId, null);
  assert.equal(retiredAtm.cashHistoricalReconciliationOnly, true);
  assert.equal(retiredAtm.cashPhysicalReconciliationRequired, false);
  assert.equal(retiredAtm.cashAuditReadback, null);
  assert.equal(retiredVisit.cashHistoricalAuditWarning, true);
  assert.deepEqual(retiredVisit.cashRetirementReadback, report);
  assert.deepEqual(retiredLedger.reconciliationReasons, legacyReasons);
  assert.deepEqual(retiredLedger, before);
  assert.equal(retiredLedger.notes[0]?.returned, false);
  assert.equal(retiredLedger.notes[0]?.stored, false);
  assert.equal(retiredLedger.notes[0]?.credited, false);
  assert.equal(retiredLedger.notes[0]?.credited, before.notes[0]?.credited);
});

test('historical ADC retirement still requires the current controller to be healthy', async () => {
  seedPendingReturnAudit();
  const visitId = 'a'.repeat(64);
  const report = { observedAt: Date.now(), deviceId, deviceState: 'DISABLED' as const,
    escrowEmpty: true as const, inventory: inventory(2), rawSequence: 6 };
  await payout.reportPayoutInventory(atmId, `Bearer ${controllerToken}`, report);
  const atm = store.records.get(`atms/${atmId}`);
  atm.controllerHealth.deviceStarted = false;
  store.records.set(`atms/${atmId}`, atm);

  await assert.rejects(atmService.retireHistoricalCashAfterReadback(atmId, visitId),
    { code: 'CASH_CONTROLLER_NOT_READY' });
  assert.equal(store.records.get(`atms/${atmId}`).activeVisitId, visitId);
  assert.equal(store.records.get(`visits/${visitId}`).cashRetiredAt, undefined);
});

test('unknown historical intake command cannot submit or consume a physical audit readback', async () => {
  seedPendingReturnAudit();
  store.records.set(`controllerCommands/cash-start-${cashSessionId}`, {
    ...store.records.get(`controllerCommands/cash-start-${cashSessionId}`), state: 'unknown',
  });
  await assert.rejects(payout.reportPayoutInventory(atmId, `Bearer ${controllerToken}`, {
    observedAt: Date.now(), deviceId, deviceState: 'DISABLED', escrowEmpty: true, inventory: inventory(2), rawSequence: 5,
  }), { code: 'PAYOUT_AUDIT_READBACK_UNAVAILABLE' });
  assert.equal(store.records.get(`atms/${atmId}`).cashAuditReadback, undefined);
});

test('audited closed unresolved ledger charges only positively credited stored notes', async () => {
  seedPendingReturnAudit();
  const visitId = 'a'.repeat(64);
  const visitPath = `visits/${visitId}`;
  const report = { observedAt: Date.now(), deviceId, deviceState: 'DISABLED' as const, escrowEmpty: true as const,
    inventory: inventory(0), rawSequence: 5 };
  store.records.set(visitPath, { ...store.records.get(visitPath), state: 'closed', cashRetiredAt: Date.now(),
    cashHistoricalAuditWarning: true, cashRetirementReadback: report });
  store.records.set(`atms/${atmId}`, { ...store.records.get(`atms/${atmId}`), activeVisitId: null,
    cashPhysicalReconciliationRequired: false, cashHistoricalReconciliationOnly: true });
  const { invoice } = await createAndPayInvoice();
  assert.equal(invoice.cashPaise, '10000');
  assert.deepEqual(invoice.donationIds, []);
  const ledger = store.records.get(`cashSessions/${cashSessionId}`).ledger;
  assert.equal(ledger.notes[1]?.returned, false);
  assert.equal(ledger.notes[1]?.credited, false);
});
