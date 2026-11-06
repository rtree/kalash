import { CASH_LIMIT_PAISE, VISIT_REFERENCE, type VisitState } from './atm.ts';

export const CASH_DENOMINATIONS = ['1000', '2000', '5000', '10000', '20000', '50000'] as const;
export const CASH_DEMO_LIMIT_PAISE = '100000';
export const CASH_DEMO_NOTE_LIMIT = 10;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = /^[A-Za-z0-9_.:-]{1,160}$/;
const noteKey = /^[A-Za-z0-9_:-]{1,128}$/;
export interface CashInventory {
  levels: { valuePaise: string; payout: number; cashbox: number }[];
  counters: { stored: number; stacked: number; dispensed: number; transferredToStack: number };
}
export interface CashReadinessEvidence {
  version: 'itl-idle-after-enable-v1';
  commandId: string;
  cashSessionId: string;
  deviceId: string;
  disabledObservedAt: number;
  enableDispatchedAt: number;
  enableAcknowledgedAt: number;
  idleObservedAt: number;
  disabledRawSequence: number;
  rawSequence: number;
  deviceStateCode: 5;
  manualEscrow: true;
  routesVerified: true;
  escrowEmpty: true;
  deviceHealthy: true;
  baseline: CashInventory;
  inventory: CashInventory;
}
interface NoteIdentity { noteKey: string; valuePaise: string; currency: 'INR' }
export type CashEventData =
  | { type: 'intake_started'; data: { inventory: CashInventory } }
  | { type: 'note_escrow'; data: NoteIdentity & { decision: 'accept' | 'return' } }
  | { type: 'note_stored'; data: NoteIdentity & { route: 'payout' } }
  | { type: 'note_returned'; data: NoteIdentity }
  | { type: 'needs_reconciliation'; data: { reason: string } }
  | { type: 'intake_closed'; data: {
    reason: CashCloseReason; inventory: CashInventory; creditedNotes: number;
    creditedPaise: string; uncreditedNotes: number; disabled: boolean; escrowEmpty: boolean;
    reconciliationReasons: string[];
  } };
export type CashCloseReason = 'done' | 'deadline' | 'capacity' | 'offline' | 'fault';
export type CashEvent = CashEventData & {
  streamId: string; sequence: number; deviceEventId: string; occurredAt: number;
  visitId: string; cashSessionId: string;
};
export interface CashSessionDto {
  visitId: string; cashSessionId: string; state: VisitState; deadline: number | null;
  closeRequested: boolean; closeReason: CashCloseReason | null;
}
export interface CashNote extends NoteIdentity {
  decision: 'accept' | 'return' | null;
  stored: boolean;
  returned: boolean;
  credited: boolean;
}
export interface CashLedger {
  baseline: CashInventory | null;
  notes: CashNote[];
  reconciliationReasons: string[];
  closed: boolean;
}
export function newCashLedger(): CashLedger {
  return { baseline: null, notes: [], reconciliationReasons: [], closed: false };
}
export function applyCashEvent(current: CashLedger, event: CashEvent): CashLedger {
  const ledger = structuredClone(current);
  const flag = (reason: string) => {
    if (!ledger.reconciliationReasons.includes(reason)) ledger.reconciliationReasons.push(reason);
  };
  if (ledger.closed) {
    flag('event_after_close');
    return ledger;
  }
  if (event.type === 'needs_reconciliation') {
    flag(event.data.reason);
    return ledger;
  }
  if (event.type === 'intake_started') {
    if (ledger.baseline || ledger.notes.length) flag('duplicate_or_late_baseline');
    else ledger.baseline = event.data.inventory;
    return ledger;
  }
  if (!ledger.baseline) flag('missing_baseline');
  if (event.type === 'intake_closed') {
    ledger.reconciliationReasons = reconcileCash(ledger, event.data);
    ledger.closed = true;
    return ledger;
  }
  let note = ledger.notes.find((item) => item.noteKey === event.data.noteKey);
  if (note && (note.valuePaise !== event.data.valuePaise || note.currency !== event.data.currency)) {
    flag('note_identity_mismatch');
    return ledger;
  }
  if (!note) {
    note = {
      noteKey: event.data.noteKey, valuePaise: event.data.valuePaise, currency: event.data.currency,
      decision: null, stored: false, returned: false, credited: false,
    };
    ledger.notes.push(note);
  }
  if (event.type === 'note_escrow') {
    if (note.decision !== null || note.stored || note.returned) flag('repeated_note_escrow');
    else {
      note.decision = event.data.decision;
      if (note.decision === 'accept') {
        const reserved = ledger.notes.filter((item) => item.stored || (item.decision === 'accept' && !item.returned))
          .reduce((sum, item) => sum + BigInt(item.valuePaise), 0n);
        if (reserved > BigInt(CASH_LIMIT_PAISE)) flag('escrow_session_limit_exceeded');
      }
    }
  } else if (event.type === 'note_stored') {
    if (note.stored) flag('repeated_note_stored');
    else {
      note.stored = true;
      note.credited = Boolean(ledger.baseline) && note.decision === 'accept' && !note.returned;
      if (!note.credited) flag('unmatched_or_returned_stored');
      if (cashTotals(ledger).storedPaise > BigInt(CASH_LIMIT_PAISE)) {
        note.credited = false;
        flag('session_limit_exceeded');
      }
    }
  } else {
    if (note.returned || note.stored) flag('conflicting_note_return');
    if (note.decision === null) flag('unmatched_note_return');
    note.returned = true;
    if (note.stored) note.credited = false;
  }
  return ledger;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, keys: string[]) {
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), 'Missing or unknown cash fields.');
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function paise(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value);
}
export function validateCashInventory(input: unknown): CashInventory {
  const value = object(input);
  fields(value, ['levels', 'counters']);
  check(Array.isArray(value.levels) && value.levels.length === CASH_DENOMINATIONS.length, 'All six INR levels are required.');
  const seen = new Set<string>();
  for (const entry of value.levels) {
    const level = object(entry);
    fields(level, ['valuePaise', 'payout', 'cashbox']);
    check(typeof level.valuePaise === 'string'
      && CASH_DENOMINATIONS.some((denomination) => denomination === level.valuePaise)
      && !seen.has(level.valuePaise), 'Invalid or duplicate denomination.');
    check(integer(level.payout) && integer(level.cashbox), 'Explicit integer payout and cashbox levels are required.');
    seen.add(level.valuePaise);
  }
  const counters = object(value.counters);
  fields(counters, ['stored', 'stacked', 'dispensed', 'transferredToStack']);
  check(Object.values(counters).every(integer), 'All four explicit counters are required.');
  return input as CashInventory;
}
export function validateCashReadinessEvidence(input: unknown): CashReadinessEvidence {
  const value = object(input);
  fields(value, [
    'version', 'commandId', 'cashSessionId', 'deviceId', 'disabledObservedAt', 'enableDispatchedAt',
    'enableAcknowledgedAt', 'idleObservedAt', 'disabledRawSequence', 'rawSequence', 'deviceStateCode',
    'manualEscrow', 'routesVerified', 'escrowEmpty', 'deviceHealthy', 'baseline', 'inventory',
  ]);
  check(value.version === 'itl-idle-after-enable-v1'
    && typeof value.cashSessionId === 'string' && uuid.test(value.cashSessionId)
    && value.commandId === `cash-start-${value.cashSessionId}`
    && typeof value.deviceId === 'string' && value.deviceId.length > 0 && value.deviceId.length <= 128,
  'Explicit readiness command, cash session and device binding are required.');
  check(integer(value.disabledObservedAt) && value.disabledObservedAt > 0
    && integer(value.enableDispatchedAt) && integer(value.enableAcknowledgedAt) && integer(value.idleObservedAt)
    && value.disabledObservedAt <= value.enableDispatchedAt
    && value.enableDispatchedAt <= value.enableAcknowledgedAt
    && value.enableAcknowledgedAt <= value.idleObservedAt
    && value.enableDispatchedAt < value.idleObservedAt,
  'Readiness must follow the actual disabled, enable dispatch, acknowledgement and new IDLE observations.');
  check(integer(value.disabledRawSequence) && integer(value.rawSequence) && value.rawSequence > value.disabledRawSequence,
    'A newer durable owned-reader sequence is required.');
  check(value.deviceStateCode === 5 && value.manualEscrow === true && value.routesVerified === true
    && value.escrowEmpty === true && value.deviceHealthy === true, 'An explicit healthy empty manual-escrow IDLE readback is required.');
  const baseline = validateCashInventory(value.baseline);
  const inventory = validateCashInventory(value.inventory);
  check(baseline.levels.every((before) => {
    const after = inventory.levels.find((level) => level.valuePaise === before.valuePaise)!;
    return after.payout === before.payout && after.cashbox === before.cashbox;
  }) && (Object.keys(baseline.counters) as (keyof CashInventory['counters'])[])
    .every((key) => baseline.counters[key] === inventory.counters[key]), 'Readiness inventory and all counters must be unchanged.');
  return structuredClone(input) as CashReadinessEvidence;
}
export function validateCashEvent(input: unknown): CashEvent {
  const value = object(input);
  fields(value, ['streamId', 'sequence', 'deviceEventId', 'occurredAt', 'visitId', 'cashSessionId', 'type', 'data']);
  check(typeof value.streamId === 'string' && uuid.test(value.streamId), 'A durable stream UUID is required.');
  check(integer(value.sequence) && value.sequence > 0, 'A positive safe event sequence is required.');
  check(value.deviceEventId === `${value.streamId}:${value.sequence}`, 'Event ID must match stream and sequence.');
  check(integer(value.occurredAt) && value.occurredAt > 0 && value.occurredAt <= 8_640_000_000_000_000, 'An epoch-millisecond event time is required.');
  check(typeof value.visitId === 'string' && VISIT_REFERENCE.test(value.visitId)
    && typeof value.cashSessionId === 'string' && uuid.test(value.cashSessionId), 'A bound visit and cash session are required.');
  const data = object(value.data);
  switch (value.type) {
    case 'intake_started':
      fields(data, ['inventory']);
      validateCashInventory(data.inventory);
      break;
    case 'note_escrow':
    case 'note_stored':
    case 'note_returned':
      fields(data, ['noteKey', 'valuePaise', 'currency', ...(value.type === 'note_escrow' ? ['decision'] : value.type === 'note_stored' ? ['route'] : [])]);
      check(typeof data.noteKey === 'string' && noteKey.test(data.noteKey), 'A stable note key is required.');
      check(typeof data.valuePaise === 'string' && CASH_DENOMINATIONS.some((denomination) => denomination === data.valuePaise)
        && data.currency === 'INR', 'Only explicit supported INR denominations are accepted.');
      if (value.type === 'note_escrow') check(data.decision === 'accept' || data.decision === 'return', 'Explicit escrow decision is required.');
      if (value.type === 'note_stored') check(data.route === 'payout', 'Only payout storage may be credited.');
      break;
    case 'needs_reconciliation':
      fields(data, ['reason']);
      check(typeof data.reason === 'string' && code.test(data.reason), 'A bounded reconciliation code is required.');
      break;
    case 'intake_closed':
      fields(data, ['reason', 'inventory', 'creditedNotes', 'creditedPaise', 'uncreditedNotes', 'disabled', 'escrowEmpty', 'reconciliationReasons']);
      check(['done', 'deadline', 'capacity', 'offline', 'fault'].includes(String(data.reason)), 'Invalid close reason.');
      validateCashInventory(data.inventory);
      check(integer(data.creditedNotes) && paise(data.creditedPaise) && integer(data.uncreditedNotes), 'Explicit close ledger totals are required.');
      check(typeof data.disabled === 'boolean' && typeof data.escrowEmpty === 'boolean', 'Physical close observations are required.');
      check(Array.isArray(data.reconciliationReasons) && data.reconciliationReasons.length <= 64
        && data.reconciliationReasons.every((reason) => typeof reason === 'string' && code.test(reason)), 'Invalid reconciliation reason codes.');
      break;
    default: throw new Error('Unknown cash event type.');
  }
  return structuredClone(input) as CashEvent;
}
export function cashTotals(ledger: CashLedger) {
  const stored = ledger.notes.filter((note) => note.stored);
  const credited = stored.filter((note) => note.credited);
  return {
    storedNotes: stored.length,
    storedPaise: stored.reduce((sum, note) => sum + BigInt(note.valuePaise), 0n),
    creditedNotes: credited.length,
    creditedPaise: credited.reduce((sum, note) => sum + BigInt(note.valuePaise), 0n),
  };
}
export function reconcileCash(ledger: CashLedger, close: Extract<CashEventData, { type: 'intake_closed' }>['data']): string[] {
  const reasons = new Set([...ledger.reconciliationReasons, ...close.reconciliationReasons]);
  const { storedNotes, storedPaise, creditedNotes, creditedPaise } = cashTotals(ledger);
  if (!close.disabled) reasons.add('acceptor_not_disabled');
  if (!close.escrowEmpty || ledger.notes.some((note) => !note.stored && !note.returned)) reasons.add('unresolved_escrow');
  if (close.uncreditedNotes !== 0 || storedNotes !== creditedNotes) reasons.add('uncredited_notes');
  if (close.creditedNotes !== creditedNotes || BigInt(close.creditedPaise) !== creditedPaise) reasons.add('credit_mismatch');
  if (storedPaise > BigInt(CASH_LIMIT_PAISE)) reasons.add('session_limit_exceeded');
  if (close.reason === 'fault') reasons.add('controller_fault');
  if (!ledger.baseline) reasons.add('missing_baseline');
  else {
    for (const before of ledger.baseline.levels) {
      const after = close.inventory.levels.find((level) => level.valuePaise === before.valuePaise)!;
      const expected = ledger.notes.filter((note) => note.stored && note.credited && note.valuePaise === before.valuePaise).length;
      if (BigInt(after.payout) - BigInt(before.payout) !== BigInt(expected)) reasons.add('payout_level_mismatch');
      if (after.cashbox !== before.cashbox) reasons.add('cashbox_level_changed');
    }
    for (const key of ['stored', 'stacked', 'dispensed', 'transferredToStack'] as const) {
      const delta = BigInt(close.inventory.counters[key]) - BigInt(ledger.baseline.counters[key]);
      if (delta !== BigInt(key === 'stored' ? creditedNotes : 0)) reasons.add(`${key}_counter_mismatch`);
    }
  }
  return [...reasons];
}
