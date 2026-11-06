import { createHash } from 'node:crypto';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { CASH_LIMIT_PAISE } from '../atm.ts';
import {
  CASH_DEMO_LIMIT_PAISE, CASH_DEMO_NOTE_LIMIT, applyCashEvent, cashTotals,
  newCashLedger, validateCashEvent, type CashEvent, type CashLedger, type CashSessionDto,
} from '../cash.ts';
import { donationPointUnits, type CashDonation } from '../shared.ts';
import { db } from './config.ts';
import { temples } from './catalog.ts';
import {
  atmReference, cashCloseUpdate, credentialHash, validAtm, visitReference,
  type AtmRecord, type VisitRecord,
} from './atm.ts';
import { HttpError, requireValue } from './errors.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function controller(atm: AtmRecord, authorization: string | undefined) {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  requireValue(token && credentialHash(token) === atm.credentialHash,
    401, 'CONTROLLER_AUTH_REQUIRED', 'A registered Controller credential is required.');
}
function bound(visit: VisitRecord | undefined, atm: AtmRecord): asserts visit is VisitRecord & {
  cashSessionId: string; ownerWallet: NonNullable<VisitRecord['ownerWallet']>; cashConsentChallenge: string;
} {
  requireValue(visit && visit.mode === 'cash' && visit.atmId === atm.id && visit.templeId === atm.templeId
    && visit.cashSessionId && visit.ownerWallet && visit.cashConsentChallenge,
  409, 'CASH_SESSION_MISMATCH', 'An explicitly consented cash session for this Controller is required.');
}
export async function getControllerCashSession(atmId: string, authorization: string | undefined) {
  const ref = atmReference(atmId);
  return db.runTransaction(async (tx): Promise<{ session: CashSessionDto | null }> => {
    const atm = validAtm((await tx.get(ref)).data() as AtmRecord | undefined);
    controller(atm, authorization);
    if (!atm.activeVisitId) return { session: null };
    const visitRef = visitReference(atm.activeVisitId);
    const visit = (await tx.get(visitRef)).data() as VisitRecord | undefined;
    if (!visit || visit.mode !== 'cash' || !visit.cashConsentChallenge) return { session: null };
    bound(visit, atm);
    if (['closed', 'confirmed'].includes(visit.state)) return { session: null };
    const expired = visit.state === 'accepting' && (visit.cashDeadline ?? 0) <= Date.now();
    const stop = expired ? cashCloseUpdate(visit, 'deadline')
      : atm.cashReconciliationRequired || atm.activePayoutId ? { ...cashCloseUpdate(visit, 'fault'), state: 'reconciling' as const } : null;
    if (stop) tx.update(visitRef, stop);
    return { session: {
      visitId: visit.id, cashSessionId: visit.cashSessionId,
      state: stop ? stop.state as VisitRecord['state'] : visit.state,
      deadline: visit.cashDeadline ?? null,
      closeRequested: stop?.cashCloseRequested ?? visit.cashCloseRequested === true,
      closeReason: stop?.cashCloseReason ?? visit.cashCloseReason ?? null,
    } };
  });
}
interface CashSessionRecord {
  atmId: string; visitId: string; cashSessionId: string; streamId: string; ledger: CashLedger;
}
function pending(ledger: CashLedger) {
  const notes = ledger.notes.filter((note) => note.decision === 'accept' && !note.stored && !note.returned);
  return { notes: notes.length, paise: notes.reduce((sum, note) => sum + BigInt(note.valuePaise), 0n) };
}
export async function reportControllerCashEvent(
  atmId: string, authorization: string | undefined, body: Record<string, unknown>,
) {
  const atmRef = atmReference(atmId);
  // Authenticate before validating or recording evidence, including malformed device reports.
  controller(validAtm((await atmRef.get()).data() as AtmRecord | undefined), authorization);
  let event: CashEvent;
  try { event = validateCashEvent(body); } catch {
    await db.runTransaction(async (tx) => {
      const atm = validAtm((await tx.get(atmRef)).data() as AtmRecord | undefined);
      controller(atm, authorization);
      const visitRef = typeof body.visitId === 'string' && /^[a-f0-9]{64}$/.test(body.visitId)
        ? visitReference(body.visitId) : null;
      const visit = visitRef ? (await tx.get(visitRef)).data() as VisitRecord | undefined : undefined;
      tx.set(atmRef.collection('cashRejectedEvents').doc(digest(body)), {
        code: 'INVALID_CASH_EVENT', payloadHash: digest(body), receivedAt: Date.now(),
      });
      tx.update(atmRef, { cashReconciliationRequired: true });
      if (visitRef && visit?.mode === 'cash' && visit.atmId === atm.id && visit.cashSessionId === body.cashSessionId) {
        tx.update(visitRef, { ...cashCloseUpdate(visit, 'fault'), state: 'reconciling', reconciliationReason: 'invalid_cash_event' });
      }
    });
    throw new HttpError(400, 'INVALID_CASH_EVENT', 'Explicit valid cash-event fields, levels and counters are required.');
  }
  const payloadHash = digest(event);
  const result = await db.runTransaction(async (tx) => {
    const visitRef = visitReference(event.visitId);
    const sessionRef = db.collection('cashSessions').doc(event.cashSessionId);
    const streamRef = atmRef.collection('cashStreams').doc(event.streamId);
    const eventRef = atmRef.collection('cashEvents').doc(event.deviceEventId);
    const budgetRef = db.collection('cashBudgets').doc('demo');
    const [atmSnapshot, visitSnapshot, sessionSnapshot, streamSnapshot, eventSnapshot, budgetSnapshot] = await Promise.all([
      tx.get(atmRef), tx.get(visitRef), tx.get(sessionRef), tx.get(streamRef), tx.get(eventRef), tx.get(budgetRef),
    ]);
    const atm = validAtm(atmSnapshot.data() as AtmRecord | undefined);
    controller(atm, authorization);
    const visit = visitSnapshot.data() as VisitRecord | undefined;
    bound(visit, atm);
    requireValue(visit.cashSessionId === event.cashSessionId, 409, 'CASH_SESSION_MISMATCH', 'Cash session does not match the visit.');
    const [consentSnapshot, commandSnapshot] = await Promise.all([
      tx.get(db.collection('cashConsentChallenges').doc(visit.cashConsentChallenge)),
      tx.get(db.collection('controllerCommands').doc(`cash-start-${visit.cashSessionId}`)),
    ]);
    const consent = consentSnapshot.data();
    const command = commandSnapshot.data();
    requireValue(consent?.used === true && consent.visitId === visit.id && consent.cashSessionId === visit.cashSessionId
      && consent.atmId === atm.id && consent.templeId === visit.templeId
      && consent.wallet?.toLowerCase() === visit.ownerWallet.toLowerCase()
      && command?.atmId === atm.id && command.visitId === visit.id && command.cashSessionId === visit.cashSessionId
      && command.templeId === visit.templeId,
    409, 'CASH_CONSENT_REQUIRED', 'The used wallet consent and durable command must match this cash session.');
    const reject = (code: string, message: string) => {
      tx.set(atmRef.collection('cashRejectedEvents').doc(payloadHash), {
        code, payloadHash, event, receivedAt: Date.now(),
      });
      tx.update(atmRef, { cashReconciliationRequired: true });
      tx.update(visitRef, { ...cashCloseUpdate(visit, 'fault'), state: 'reconciling', reconciliationReason: code });
      return { error: new HttpError(409, code, message) };
    };
    if (eventSnapshot.exists) {
      if (eventSnapshot.get('payloadHash') !== payloadHash) {
        return reject('CASH_EVENT_DUPLICATE_MISMATCH', 'This event ID was already recorded with another payload.');
      }
      return { accepted: true as const, streamId: event.streamId, sequence: event.sequence };
    }
    if (atm.cashStreamId && atm.cashStreamId !== event.streamId) {
      return reject('CASH_STREAM_RESET', 'The persistent ATM cash stream cannot be reset to bypass missing evidence.');
    }
    const stream = streamSnapshot.data();
    if (event.sequence !== (stream?.lastSequence ?? 0) + 1) {
      return reject('CASH_EVENT_SEQUENCE_GAP', 'Deliver the next persisted event in order; no sequence may be skipped.');
    }
    if (event.occurredAt < (stream?.lastOccurredAt ?? 0) || event.occurredAt > Date.now() + 30_000) {
      return reject('CASH_EVENT_TIME_ORDER', 'Cash evidence is reordered or dated in the future.');
    }
    const session = sessionSnapshot.data() as CashSessionRecord | undefined;
    if (session && (session.atmId !== atm.id || session.visitId !== visit.id || session.streamId !== event.streamId)) {
      return reject('CASH_LEDGER_BINDING_MISMATCH', 'The durable ledger is bound to another ATM, visit or stream.');
    }
    if (atm.activeVisitId !== visit.id || session?.ledger.closed || ['closed', 'confirmed'].includes(visit.state)) {
      return reject('CASH_EVENT_AFTER_CLOSE', 'New evidence after closure requires operator reconciliation.');
    }
    const before = session?.ledger ?? newCashLedger();
    const ledger = applyCashEvent(before, event);
    const flag = (reason: string) => {
      if (!ledger.reconciliationReasons.includes(reason)) ledger.reconciliationReasons.push(reason);
    };
    if (atm.cashReconciliationRequired || ['reconciling', 'needs_reconciliation'].includes(visit.state)) flag('prior_reconciliation_required');
    if (event.type === 'intake_started' && (!['observed', 'reported'].includes(command.state)
      || !['accepting', 'closing'].includes(visit.state) || !visit.cashDeadline)) flag('start_not_observed_ready');
    if (event.type === 'intake_started' && command.readinessEvidence
      && digest(event.data.inventory) !== digest(command.readinessEvidence.baseline)) flag('readiness_baseline_mismatch');
    if (event.type === 'intake_closed' && event.data.reason === 'done' && !visit.cashCloseRequested) {
      flag('done_not_requested');
    }
    if (event.type === 'intake_closed' && event.data.reason === 'deadline'
      && (!visit.cashDeadline || event.occurredAt < visit.cashDeadline)) flag('premature_deadline_close');
    if (event.type === 'note_escrow' && event.data.decision === 'accept'
      && (event.occurredAt >= (visit.cashDeadline ?? 0)
        || (visit.cashCloseRequested && event.occurredAt >= (visit.cashCloseRequestedAt ?? 0)))) {
      flag('accept_after_stop');
    }
    const oldTotals = cashTotals(before);
    const totals = cashTotals(ledger);
    const oldPending = pending(before);
    const nextPending = pending(ledger);
    const budget = budgetSnapshot.data();
    const storedPaise = BigInt(budget?.storedPaise ?? '0') + totals.storedPaise - oldTotals.storedPaise;
    const storedNotes = (budget?.storedNotes ?? 0) + totals.storedNotes - oldTotals.storedNotes;
    const pendingPaise = BigInt(budget?.pendingPaise ?? '0') + nextPending.paise - oldPending.paise;
    const pendingNotes = (budget?.pendingNotes ?? 0) + nextPending.notes - oldPending.notes;
    if (storedPaise + pendingPaise > BigInt(CASH_DEMO_LIMIT_PAISE)
      || storedNotes + pendingNotes > CASH_DEMO_NOTE_LIMIT) flag('demo_limit_exceeded');
    const donationId = `0x${digest({ purpose: 'cash-donation-v1', atmId, cashSessionId: visit.cashSessionId })}` as Hex;
    const donationRef = db.collection('donations').doc(donationId);
    const totalRef = db.collection('walletTempleTotals').doc(`${visit.ownerWallet.toLowerCase()}_${visit.templeId}`);
    const jobRef = db.collection('mintJobs').doc(donationId);
    const shouldConfirm = event.type === 'intake_closed' && ledger.reconciliationReasons.length === 0 && totals.creditedPaise > 0n;
    const settlement = shouldConfirm ? await Promise.all([tx.get(donationRef), tx.get(totalRef), tx.get(jobRef)]) : null;
    if (settlement && (settlement[0].exists || settlement[2].exists || visit.donationId)) {
      return reject('CASH_SETTLEMENT_CONFLICT', 'Donation or mint reservation exists without the matching accepted close event.');
    }
    const now = Date.now();
    const visitUpdate: Record<string, unknown> = { cashAcceptedPaise: totals.storedPaise.toString(), cashStreamId: event.streamId };
    if (ledger.reconciliationReasons.length) {
      Object.assign(visitUpdate, cashCloseUpdate(visit, 'fault'), { state: 'reconciling', reconciliationReasons: ledger.reconciliationReasons });
    } else if (event.type === 'intake_closed') {
      Object.assign(visitUpdate, {
        state: shouldConfirm ? 'confirmed' : 'closed', cashCloseRequested: true,
        cashCloseReason: event.data.reason, closedAt: now,
        ...(shouldConfirm ? { donationId, confirmedAt: now } : {}),
      });
    } else if (totals.storedPaise >= BigInt(CASH_LIMIT_PAISE)
      || storedPaise >= BigInt(CASH_DEMO_LIMIT_PAISE) || storedNotes >= CASH_DEMO_NOTE_LIMIT) {
      Object.assign(visitUpdate, cashCloseUpdate(visit, 'capacity'));
    } else if (visit.state === 'accepting' && (visit.cashDeadline ?? 0) <= now) {
      Object.assign(visitUpdate, cashCloseUpdate(visit, 'deadline'));
    }
    if (settlement) {
      const temple = temples.find((item) => item.id === visit.templeId)!;
      const amount = totals.creditedPaise * 100n;
      const fee = amount * 3n / 100n;
      const confirmedAt = new Date(now).toISOString();
      const donation: CashDonation = {
        id: donationId, paymentMethod: 'cash', chainId: null, txHash: null,
        ownerWallet: getAddress(visit.ownerWallet), templeId: visit.templeId, templeKey: keccak256(toHex(visit.templeId)),
        kind: 1, onsiteVisitId: visit.id, cashSessionId: visit.cashSessionId,
        cashAmountPaise: totals.creditedPaise.toString(), cashFeeStatus: 'unpaid',
        amount: amount.toString(), fee: fee.toString(), net: (amount - fee).toString(),
        recipient: temple.recipient, status: 'confirmed', mintStatus: 'reserved', createdAt: confirmedAt, confirmedAt,
      };
      tx.create(donationRef, donation);
      tx.set(totalRef, {
        wallet: visit.ownerWallet.toLowerCase(), templeId: visit.templeId,
        points: (BigInt(settlement[1].get('points') ?? '0') + donationPointUnits(donation.amount, 1)).toString(),
      });
      tx.create(jobRef, {
        donationId, ownerWallet: donation.ownerWallet, templeKey: donation.templeKey, kind: 1,
        day: (BigInt(now) / 86_400_000n).toString(), status: 'reserved', createdAt: confirmedAt,
      });
    }
    tx.create(eventRef, { payloadHash, event, receivedAt: now });
    tx.set(streamRef, { lastSequence: event.sequence, lastOccurredAt: event.occurredAt });
    tx.set(sessionRef, { atmId, visitId: visit.id, cashSessionId: visit.cashSessionId, streamId: event.streamId, ledger });
    tx.set(budgetRef, {
      storedPaise: storedPaise.toString(), storedNotes, pendingPaise: pendingPaise.toString(), pendingNotes,
    });
    tx.update(visitRef, visitUpdate);
    tx.update(atmRef, {
      cashStreamId: event.streamId,
      ...(ledger.reconciliationReasons.length ? { cashReconciliationRequired: true } : {}),
      ...(event.type === 'intake_closed' && !ledger.reconciliationReasons.length && !shouldConfirm ? { activeVisitId: null } : {}),
    });
    return { accepted: true as const, streamId: event.streamId, sequence: event.sequence };
  });
  if ('error' in result) throw result.error;
  return result;
}
