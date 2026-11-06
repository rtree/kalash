import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  reconcileFailedCashStart, validateFailedStartZeroReconciliation, verifyFailedStartArchives,
} from '../scripts/reconcile-failed-cash-start.mjs';
import { cashDonationId, cashEvidenceHash } from '../scripts/verify-cash-session.mjs';
import { CASH_DENOMINATIONS } from '../src/cash.ts';

// Local evidence/transaction fixtures only. No live database, files, Controller or device operations.
const now = Date.parse('2026-11-06T20:00:00Z');
const sessionId = '2a364965-289e-4bff-abdf-e7af7cab0c3e';
const streamId = 'bceb8c2d-2fc4-44c9-b539-b430e69b61ba';
const visitId = 'a'.repeat(64);
const owner = `0x${'11'.repeat(20)}`;
const commandId = `cash-start-${sessionId}`;
const reasons = ['ready_not_observed', 'start_command_not_observed'];
const ledgerReasons = [...reasons, 'prior_reconciliation_required', 'missing_baseline', 'controller_fault'];
const inventory = () => ({
  levels: CASH_DENOMINATIONS.map((valuePaise) => ({
    valuePaise, payout: 0, cashbox: ['1000', '2000'].includes(valuePaise) ? 2 : valuePaise === '20000' ? 1 : 0,
  })),
  counters: { stored: 54, stacked: 2, dispensed: 53, transferredToStack: 1 },
});
const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const command = {
    commandId, type: 'start_cash', state: 'unknown', reason: 'acceptance_state_not_observed',
    atmId: 'atm-01', visitId, cashSessionId: sessionId, templeId: 'temple-01', createdAt: now - 180000, expiresAt: now - 60000,
  };
  const state = {
    streamId, deviceId: 'fixture-device', acknowledgedSequence: 3, nextSequence: 4, pollInFlight: false,
    outbox: [], locked: true, lockReasons: reasons,
    intake: {
      command, started: false, closed: true, disabledObserved: true, enableDispatchStarted: true,
      disableDispatchStarted: true, deadline: null, notes: [], closeReason: 'fault', reasons,
      baseline: inventory(), finalInventory: inventory(),
    },
  };
  const journal = {
    Command: command, State: 'unknown', Reason: 'acceptance_state_not_observed', Observation: null, PendingReportState: null,
  };
  const archives = {
    state: Buffer.from(JSON.stringify(state)), raw: Buffer.from('{"sequence":1,"deviceState":"IDLE"}\n{"sequence":2,"deviceState":"DISABLED"}\n'),
    command: Buffer.from(JSON.stringify(journal)),
  };
  const proof = {
    version: 'failed-cash-start-zero-v1', atmId: 'atm-01', visitId, cashSessionId: sessionId,
    commandId, streamId, deviceId: 'fixture-device', acknowledgedSequence: 3, nextSequence: 4,
    started: false, closed: true, disabledObserved: true, pollInFlight: false, outboxCount: 0, noteCount: 0,
    deviceState: 'DISABLED', escrowEmpty: true, observedAt: now, baseline: inventory(), finalInventory: inventory(),
    currentInventory: inventory(), controllerStateSha256: bytesHash(archives.state),
    rawJournalSha256: bytesHash(archives.raw), commandJournalSha256: bytesHash(archives.command),
    operatorConfirmedNoNotes: true,
  };
  const rawEvents = [
    { type: 'needs_reconciliation', data: { reason: reasons[0] } },
    { type: 'needs_reconciliation', data: { reason: reasons[1] } },
    { type: 'intake_closed', data: {
      reason: 'fault', inventory: inventory(), creditedNotes: 0, creditedPaise: '0', uncreditedNotes: 0,
      disabled: true, escrowEmpty: true, reconciliationReasons: reasons,
    } },
  ].map((event, index) => ({
    streamId, sequence: index + 1, deviceEventId: `${streamId}:${index + 1}`, occurredAt: now - 10000 + index,
    visitId, cashSessionId: sessionId, ...event,
  }));
  const evidence = {
    atm: {
      id: 'atm-01', templeId: 'temple-01', activeVisitId: visitId, cashEnabled: false,
      cashReconciliationRequired: true, cashStreamId: streamId, controllerHealth: { deviceId: 'fixture-device' },
    },
    visit: {
      id: visitId, atmId: 'atm-01', templeId: 'temple-01', mode: 'cash', cashSessionId: sessionId,
      state: 'reconciling', cashAcceptedPaise: '0', cashDeadline: null, ownerWallet: owner,
      cashConsentChallenge: 'b'.repeat(48), cashCloseRequested: true, cashCloseReason: 'fault',
      reconciliationReason: 'acceptance_state_not_observed', reconciliationReasons: ledgerReasons,
    },
    session: {
      atmId: 'atm-01', visitId, cashSessionId: sessionId, streamId,
      ledger: { baseline: null, notes: [], closed: true, reconciliationReasons: ledgerReasons },
    },
    command, stream: { lastSequence: 3, lastOccurredAt: now - 9998 },
    consent: { used: true, visitId, cashSessionId: sessionId, atmId: 'atm-01', templeId: 'temple-01', wallet: owner },
    budget: { storedPaise: '0', storedNotes: 0, pendingPaise: '0', pendingNotes: 0 },
    events: rawEvents.map((event) => ({ id: event.deviceEventId, event, payloadHash: cashEvidenceHash(event), receivedAt: event.occurredAt + 1 })),
    donation: undefined, job: undefined, otherDonationCount: 0, rejectedCount: 0,
  };
  return { proof, archives, evidence };
}
class Store {
  records = new Map();
  failCommit = false;
  collection(path) {
    const query = (filters = [], maximum = Infinity) => ({
      path, filters, maximum, isQuery: true,
      where: (field, op, value) => { assert.equal(op, '=='); return query([...filters, [field, value]], maximum); },
      limit: (size) => query(filters, size),
      doc: (id) => ({ path: `${path}/${id}`, collection: (child) => this.collection(`${path}/${id}/${child}`) }),
    });
    return query();
  }
  snapshot(ref) {
    if (ref.isQuery) {
      const docs = [...this.records.entries()].filter(([path, value]) => path.startsWith(`${ref.path}/`)
        && path.split('/').length === ref.path.split('/').length + 1
        && ref.filters.every(([field, expected]) => field.split('.').reduce((item, key) => item?.[key], value) === expected))
        .slice(0, ref.maximum).map(([path]) => this.snapshot({ path }));
      return { docs, size: docs.length };
    }
    return { id: ref.path.split('/').at(-1), data: () => structuredClone(this.records.get(ref.path)) };
  }
  async runTransaction(work) {
    const writes = [];
    const result = await work({
      get: async (ref) => { assert.equal(writes.length, 0); return this.snapshot(ref); },
      create: (ref, data) => writes.push({ path: ref.path, data: structuredClone(data), create: true }),
      update: (ref, data) => writes.push({ path: ref.path, data: structuredClone(data), create: false }),
    });
    if (this.failCommit) throw new Error('injected_atomic_commit_failure');
    const next = new Map(this.records);
    for (const write of writes) {
      assert.equal(next.has(write.path), !write.create);
      next.set(write.path, write.create ? write.data : { ...next.get(write.path), ...write.data });
    }
    this.records = next;
    return result;
  }
}
function storedFixture() {
  const f = fixture();
  const db = new Store();
  for (const [path, data] of Object.entries({
    'atms/atm-01': f.evidence.atm, [`visits/${visitId}`]: f.evidence.visit,
    [`cashSessions/${sessionId}`]: f.evidence.session, [`controllerCommands/${commandId}`]: f.evidence.command,
    [`atms/atm-01/cashStreams/${streamId}`]: f.evidence.stream, 'cashBudgets/demo': f.evidence.budget,
    [`cashConsentChallenges/${'b'.repeat(48)}`]: f.evidence.consent,
  })) db.records.set(path, data);
  for (const row of f.evidence.events) db.records.set(`atms/atm-01/cashEvents/${row.id}`, {
    event: row.event, payloadHash: row.payloadHash, receivedAt: row.receivedAt,
  });
  return { ...f, db };
}
test('only archived, physically disabled, empty, exactly unchanged failed-start zero evidence validates', () => {
  const { proof, archives, evidence } = fixture();
  const result = validateFailedStartZeroReconciliation(evidence, proof, verifyFailedStartArchives(proof, archives), now);
  assert.equal(result.donationCreated, false);
  assert.equal(result.mintCreated, false);
  assert.equal(result.cashEnabled, false);
  assert.equal(result.originalCommandState, 'unknown');
});
test('every missing proof field rejects; zero/false values must be explicit, not inferred', () => {
  const original = fixture();
  for (const key of Object.keys(original.proof)) {
    const proof = structuredClone(original.proof);
    delete proof[key];
    assert.throws(() => verifyFailedStartArchives(proof, original.archives), { code: 'EXPLICIT_COMPLETE_PROOF_REQUIRED' }, key);
  }
});
test('missing/tampered archive files and nonterminal command journals reject', () => {
  for (const key of ['state', 'raw', 'command']) {
    const f = fixture();
    delete f.archives[key];
    assert.throws(() => verifyFailedStartArchives(f.proof, f.archives));
  }
  const f = fixture();
  f.archives.command = Buffer.from(JSON.stringify({ Command: f.evidence.command, State: 'dispatching' }));
  f.proof.commandJournalSha256 = bytesHash(f.archives.command);
  assert.throws(() => verifyFailedStartArchives(f.proof, f.archives), { code: 'ARCHIVED_COMMAND_NOT_TERMINAL_UNKNOWN' });
});
test('started, missing physical empty, in-flight poll, stale readback, notes and changed baseline all reject', () => {
  for (const mutate of [
    (p) => { p.started = true; }, (p) => { p.disabledObserved = false; }, (p) => { p.escrowEmpty = false; },
    (p) => { p.deviceState = 'IDLE'; }, (p) => { p.pollInFlight = true; }, (p) => { p.noteCount = 1; },
    (p) => { p.outboxCount = 1; }, (p) => { p.operatorConfirmedNoNotes = false; },
    (p) => { p.observedAt = now - 240001; }, (p) => { p.observedAt = now + 30001; },
    (p) => { p.currentInventory.counters.stored++; },
    (p) => { p.currentInventory.levels[3].payout++; }, (p) => { delete p.baseline.counters.stored; },
  ]) {
    const f = fixture();
    mutate(f.proof);
    assert.throws(() => validateFailedStartZeroReconciliation(f.evidence, f.proof,
      verifyFailedStartArchives(f.proof, f.archives), now));
  }
});
test('current DB command/visit/stream/consent mismatch or any cash/settlement evidence prevents release', () => {
  for (const mutate of [
    (e) => { e.atm.cashEnabled = true; }, (e) => { e.atm.activeVisitId = 'c'.repeat(64); },
    (e) => { e.atm.controllerHealth.deviceId = 'other-device'; }, (e) => { e.visit.cashAcceptedPaise = '10000'; },
    (e) => { e.visit.cashDeadline = now; }, (e) => { e.session.ledger.notes.push({ stored: true }); },
    (e) => { e.session.ledger.baseline = inventory(); }, (e) => { e.command.state = 'dispatching'; },
    (e) => { e.command.observedAt = now; }, (e) => { e.command.reason = 'unknown_other_fault'; },
    (e) => { e.consent.used = false; }, (e) => { e.stream.lastSequence = 4; },
    (e) => { e.donation = {}; }, (e) => { e.job = {}; }, (e) => { e.otherDonationCount = 1; },
    (e) => { e.rejectedCount = 1; }, (e) => { e.budget.pendingNotes = 1; },
    (e) => { e.events.pop(); }, (e) => { e.events[2].event.data.inventory.counters.stacked++; },
  ]) {
    const f = fixture();
    mutate(f.evidence);
    assert.throws(() => validateFailedStartZeroReconciliation(f.evidence, f.proof,
      verifyFailedStartArchives(f.proof, f.archives), now));
  }
});
test('dry-run is nonmutating; apply archives atomically while preserving original unknown command, ledger and stream', async () => {
  const { db, proof, archives } = storedFixture();
  const before = structuredClone(db.records);
  const dry = await reconcileFailedCashStart(db, proof, archives, { now });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(db.records, before);
  const result = await reconcileFailedCashStart(db, proof, archives, { now, apply: true });
  assert.equal(result.applied, true);
  assert.equal(db.records.get('atms/atm-01').activeVisitId, null);
  assert.equal(db.records.get('atms/atm-01').cashEnabled, false);
  assert.equal(db.records.get('atms/atm-01').cashReconciliationRequired, false);
  assert.equal(db.records.get(`visits/${visitId}`).state, 'closed');
  assert.deepEqual(db.records.get(`controllerCommands/${commandId}`), before.get(`controllerCommands/${commandId}`));
  assert.deepEqual(db.records.get(`cashSessions/${sessionId}`).ledger, before.get(`cashSessions/${sessionId}`).ledger);
  assert.deepEqual(db.records.get(`atms/atm-01/cashStreams/${streamId}`), before.get(`atms/atm-01/cashStreams/${streamId}`));
  assert.deepEqual(db.records.get('cashBudgets/demo'), before.get('cashBudgets/demo'));
  const archive = db.records.get(`cashFailedStartReconciliations/${sessionId}`);
  assert.equal(archive.originalCommand.state, 'unknown');
  assert.equal(archive.acceptedEvents.length, 3);
  assert.equal(archive.proofHash, cashEvidenceHash(proof));
  assert.equal(db.records.has(`donations/${cashDonationId('atm-01', sessionId)}`), false);
  assert.equal(db.records.has(`mintJobs/${cashDonationId('atm-01', sessionId)}`), false);
});
test('atomic failure leaves lock, pointer and archive unchanged', async () => {
  const { db, proof, archives } = storedFixture();
  const before = structuredClone(db.records);
  db.failCommit = true;
  await assert.rejects(reconcileFailedCashStart(db, proof, archives, { now, apply: true }), /injected_atomic_commit_failure/);
  assert.deepEqual(db.records, before);
});
test('same explicit apply is idempotent and never clears a newer active visit', async () => {
  const { db, proof, archives } = storedFixture();
  await reconcileFailedCashStart(db, proof, archives, { now, apply: true });
  db.records.set('atms/atm-01', { ...db.records.get('atms/atm-01'), activeVisitId: 'd'.repeat(64), cashEnabled: true });
  const before = structuredClone(db.records);
  const result = await reconcileFailedCashStart(db, proof, archives, { now: now + 999999, apply: true });
  assert.equal(result.duplicate, true);
  assert.deepEqual(db.records, before);
});
