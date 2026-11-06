import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CASH_DENOMINATIONS, type CashEvent, type CashEventData, type CashInventory } from '../src/cash.ts';

// Local serializable transaction double, NOT a Firestore emulator or live-service test.
class LocalStore {
  records = new Map<string, any>();
  failNextCommit = false;
  private tail: Promise<unknown> = Promise.resolve();
  collection(path: string): any {
    return { doc: (id: string) => this.ref(`${path}/${id}`) };
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
  db: store, origin, project: 'local-cash-tests-only', auth: {}, chain: {}, signer: {}, minter: {},
  deployment: { stamp: '0x0000000000000000000000000000000000000001', vault: '0x0000000000000000000000000000000000000002' },
  publicConfig: {},
} });
mock.module('../src/server/authentication.ts', { namedExports: {
  identity: async (authorization: string) => {
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
beforeEach(seed);
const makeEvent = (sequence: number, data: CashEventData): CashEvent => ({
  streamId, sequence, deviceEventId: `${streamId}:${sequence}`, occurredAt: Date.now(),
  visitId, cashSessionId, ...data,
});
const post = (event: CashEvent | Record<string, unknown>) => cash.reportControllerCashEvent(atmId, auth, event as Record<string, unknown>);
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
