import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CASH_DENOMINATIONS, applyCashEvent, cashTotals, newCashLedger, reconcileCash,
  validateCashEvent, validateCashInventory, type CashEvent, type CashInventory,
} from '../src/cash.ts';

const inventory = (): CashInventory => ({
  levels: CASH_DENOMINATIONS.map((valuePaise) => ({ valuePaise, payout: 0, cashbox: 0 })),
  counters: { stored: 0, stacked: 0, dispensed: 0, transferredToStack: 0 },
});
const event = (type: string, data: unknown): CashEvent => validateCashEvent({
  streamId: '10000000-0000-4000-8000-000000000001', sequence: 1,
  deviceEventId: '10000000-0000-4000-8000-000000000001:1', occurredAt: Date.now(),
  visitId: 'a'.repeat(64), cashSessionId: '20000000-0000-4000-8000-000000000001', type, data,
});
const note = { noteKey: 'device-note-1', valuePaise: '10000', currency: 'INR' };
const start = () => applyCashEvent(newCashLedger(), event('intake_started', { inventory: inventory() }));
const close = () => ({
  reason: 'done' as const, inventory: inventory(), creditedNotes: 0, creditedPaise: '0',
  uncreditedNotes: 0, disabled: true, escrowEmpty: true, reconciliationReasons: [],
});

test('actual C# synthetic HTTP serialization satisfies the Central event contract and close ledger', () => {
  const fixture: { synthetic: boolean; commandReports: { state: string }[]; events: unknown[] } = JSON.parse(
    readFileSync(new URL('../CashMachine/CashMachineController.Tests/fixtures/product-cash-wire.synthetic.json', import.meta.url), 'utf8'),
  );
  assert.equal(fixture.synthetic, true);
  assert.deepEqual(fixture.commandReports.map((report) => report.state),
    ['received', 'validated', 'dispatching', 'observed', 'reported']);
  const events = fixture.events.map(validateCashEvent);
  assert.deepEqual(events.map((entry) => entry.type), ['intake_started', 'note_escrow', 'note_stored', 'intake_closed']);
  assert.deepEqual(events.map((entry) => entry.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(events.map((entry) => entry.streamId)).size, 1);
  assert.equal(new Set(events.map((entry) => entry.cashSessionId)).size, 1);
  let ledger = newCashLedger();
  for (const entry of events) {
    if (entry.type === 'intake_closed') assert.deepEqual(reconcileCash(ledger, entry.data), []);
    ledger = applyCashEvent(ledger, entry);
  }
  assert.equal(ledger.closed, true);
  assert.equal(cashTotals(ledger).creditedPaise, 10000n);
  assert.equal(cashTotals(ledger).creditedNotes, 1);
});

test('cash inventory requires all six denominations and explicit finite counters', () => {
  assert.deepEqual(validateCashInventory(inventory()), inventory());
  for (const mutate of [
    (value: any) => { value.levels = []; },
    (value: any) => { value.levels.pop(); },
    (value: any) => { value.levels[0] = value.levels[1]; },
    (value: any) => { delete value.levels[0].cashbox; },
    (value: any) => { value.levels[0].payout = ''; },
    (value: any) => { value.levels[0].payout = NaN; },
    (value: any) => { value.counters = {}; },
    (value: any) => { delete value.counters.transferredToStack; },
    (value: any) => { value.counters.stored = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const input = inventory();
    mutate(input);
    assert.throws(() => validateCashInventory(input));
  }
});
test('cash envelope forbids unknown fields, invalid ordering IDs and non-payout STORED', () => {
  const valid = event('note_stored', { ...note, route: 'payout' });
  for (const invalid of [
    { ...valid, extra: 1 }, { ...valid, sequence: 0 }, { ...valid, deviceEventId: 'other' },
    { ...valid, occurredAt: 0 }, { ...valid, streamId: 'restart' },
    { ...valid, data: { ...note, route: 'cashbox' } },
    { ...valid, data: { ...note, currency: 'USD', route: 'payout' } },
    { ...valid, data: { ...note, noteKey: '', route: 'payout' } },
    { ...valid, data: { ...note, valuePaise: '', route: 'payout' } },
  ]) assert.throws(() => validateCashEvent(invalid));
});
test('matching accept and STORED credits exactly one stable note; repeats are reconciliation', () => {
  let ledger = applyCashEvent(start(), event('note_escrow', { ...note, decision: 'accept' }));
  assert.equal(cashTotals(ledger).creditedPaise, 0n);
  ledger = applyCashEvent(ledger, event('note_stored', { ...note, route: 'payout' }));
  assert.equal(cashTotals(ledger).creditedPaise, 10000n);
  ledger = applyCashEvent(ledger, event('note_stored', { ...note, route: 'payout' }));
  assert.equal(cashTotals(ledger).storedNotes, 1);
  assert.ok(ledger.reconciliationReasons.includes('repeated_note_stored'));
});
test('late STORED after returned note never revives credit', () => {
  let ledger = applyCashEvent(start(), event('note_escrow', { ...note, decision: 'accept' }));
  ledger = applyCashEvent(ledger, event('note_returned', note));
  ledger = applyCashEvent(ledger, event('note_stored', { ...note, route: 'payout' }));
  assert.equal(cashTotals(ledger).creditedPaise, 0n);
  assert.equal(cashTotals(ledger).storedPaise, 10000n);
  assert.ok(ledger.reconciliationReasons.includes('unmatched_or_returned_stored'));
});
test('unmatched STORED and altered note identities cannot produce a donation ledger', () => {
  const unmatched = applyCashEvent(start(), event('note_stored', { ...note, route: 'payout' }));
  assert.equal(cashTotals(unmatched).creditedNotes, 0);
  const accepted = applyCashEvent(start(), event('note_escrow', { ...note, decision: 'accept' }));
  const changed = applyCashEvent(accepted, event('note_stored', { ...note, valuePaise: '20000', route: 'payout' }));
  assert.equal(cashTotals(changed).storedNotes, 0);
  assert.ok(changed.reconciliationReasons.includes('note_identity_mismatch'));
});
test('₹400 exact is credited, over-cap evidence is preserved without truncation or credit', () => {
  let ledger = start();
  for (let i = 0; i < 5; i++) {
    const next = { ...note, noteKey: `note-${i}` };
    ledger = applyCashEvent(ledger, event('note_escrow', { ...next, decision: 'accept' }));
    ledger = applyCashEvent(ledger, event('note_stored', { ...next, route: 'payout' }));
    if (i === 3) assert.equal(cashTotals(ledger).creditedPaise, 40000n);
  }
  assert.equal(cashTotals(ledger).storedPaise, 50000n);
  assert.equal(cashTotals(ledger).creditedPaise, 40000n);
  assert.ok(ledger.reconciliationReasons.includes('session_limit_exceeded'));
});
test('₹300 stored plus ₹200 accepted escrow fails before STORED', () => {
  let ledger = start();
  for (let i = 0; i < 3; i++) {
    const next = { ...note, noteKey: `note-${i}` };
    ledger = applyCashEvent(ledger, event('note_escrow', { ...next, decision: 'accept' }));
    ledger = applyCashEvent(ledger, event('note_stored', { ...next, route: 'payout' }));
  }
  ledger = applyCashEvent(ledger, event('note_escrow', { ...note, noteKey: 'oversize', valuePaise: '20000', decision: 'accept' }));
  assert.ok(ledger.reconciliationReasons.includes('escrow_session_limit_exceeded'));
});
test('every close counter and denomination-level balance must reconcile', () => {
  const ledger = start();
  assert.deepEqual(reconcileCash(ledger, close()), []);
  for (const key of ['stored', 'stacked', 'dispensed', 'transferredToStack'] as const) {
    const input = close();
    input.inventory.counters[key] = 1;
    assert.ok(reconcileCash(ledger, input).includes(`${key}_counter_mismatch`));
  }
  for (const column of ['payout', 'cashbox'] as const) {
    const input = close();
    input.inventory.levels[0]![column] = 1;
    assert.notDeepEqual(reconcileCash(ledger, input), []);
  }
  assert.ok(reconcileCash(newCashLedger(), close()).includes('missing_baseline'));
});
test('unresolved escrow, controller faults, physical close and reported totals fail closed', () => {
  const ledger = applyCashEvent(start(), event('note_escrow', { ...note, decision: 'accept' }));
  assert.ok(reconcileCash(ledger, close()).includes('unresolved_escrow'));
  for (const change of [
    { disabled: false }, { escrowEmpty: false }, { creditedPaise: '10000' }, { creditedNotes: 1 },
    { uncreditedNotes: 1 }, { reason: 'fault' as const }, { reconciliationReasons: ['stacked_event'] },
  ]) assert.notDeepEqual(reconcileCash(start(), { ...close(), ...change }), []);
});
test('a closed ledger never accepts later STORED or a replacement baseline', () => {
  const closed = applyCashEvent(start(), event('intake_closed', close()));
  const late = applyCashEvent(closed, event('note_stored', { ...note, route: 'payout' }));
  assert.equal(cashTotals(late).creditedPaise, 0n);
  assert.ok(late.reconciliationReasons.includes('event_after_close'));
  assert.ok(applyCashEvent(start(), event('intake_started', { inventory: inventory() }))
    .reconciliationReasons.includes('duplicate_or_late_baseline'));
});