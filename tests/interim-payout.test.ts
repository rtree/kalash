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
