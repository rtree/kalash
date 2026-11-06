import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ATM_ID, VISIT_REFERENCE } from '../src/atm.ts';
import { validateCashEvent, validateCashInventory } from '../src/cash.ts';
import { cashDonationId, cashEvidenceHash } from './verify-cash-session.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const reasons = ['ready_not_observed', 'start_command_not_observed'];
const ledgerReasons = [...reasons, 'prior_reconciliation_required', 'missing_baseline', 'controller_fault'];
const proofFields = [
  'version', 'atmId', 'visitId', 'cashSessionId', 'commandId', 'streamId', 'deviceId',
  'acknowledgedSequence', 'nextSequence', 'started', 'closed', 'disabledObserved', 'pollInFlight',
  'outboxCount', 'noteCount', 'deviceState', 'escrowEmpty', 'observedAt',
  'baseline', 'finalInventory', 'currentInventory', 'controllerStateSha256',
  'rawJournalSha256', 'commandJournalSha256', 'operatorConfirmedNoNotes',
];
function requireProof(ok, code) {
  if (!ok) { const error = new Error(code); error.code = code; throw error; }
}
function sameReasons(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value) => expected.includes(value)) && new Set(actual).size === expected.length;
}
function sameInventory(a, b) {
  const normalize = (input) => {
    const inventory = validateCashInventory(input);
    return { ...inventory, levels: [...inventory.levels].sort((x, y) => Number(x.valuePaise) - Number(y.valuePaise)) };
  };
  return cashEvidenceHash(normalize(a)) === cashEvidenceHash(normalize(b));
}
function normalizeKeys(value) {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key[0].toLowerCase() + key.slice(1);
    requireProof(!Object.hasOwn(output, normalized), 'AMBIGUOUS_ARCHIVE_FIELDS');
    output[normalized] = normalizeKeys(item);
  }
  return output;
}
function validateProofShape(proof, now, fresh = true) {
  requireProof(proof && typeof proof === 'object' && !Array.isArray(proof)
    && Object.keys(proof).length === proofFields.length && proofFields.every((field) => Object.hasOwn(proof, field)),
  'EXPLICIT_COMPLETE_PROOF_REQUIRED');
  requireProof(proof.version === 'failed-cash-start-zero-v1' && ATM_ID.test(proof.atmId)
    && VISIT_REFERENCE.test(proof.visitId) && uuid.test(proof.cashSessionId) && uuid.test(proof.streamId)
    && proof.commandId === `cash-start-${proof.cashSessionId}`
    && typeof proof.deviceId === 'string' && proof.deviceId.length > 0 && proof.deviceId.length <= 128,
  'PROOF_BINDING_INVALID');
  requireProof(Number.isSafeInteger(proof.acknowledgedSequence) && proof.acknowledgedSequence >= 3
    && proof.nextSequence === proof.acknowledgedSequence + 1, 'PROOF_STREAM_INVALID');
  requireProof(proof.started === false && proof.closed === true && proof.disabledObserved === true
    && proof.pollInFlight === false && proof.outboxCount === 0 && proof.noteCount === 0
    && proof.deviceState === 'DISABLED' && proof.escrowEmpty === true && proof.operatorConfirmedNoNotes === true,
  'EXPLICIT_DISABLED_EMPTY_ZERO_PROOF_REQUIRED');
  requireProof(Number.isSafeInteger(proof.observedAt) && proof.observedAt > 0
    && (!fresh || (proof.observedAt <= now + 5000 && proof.observedAt >= now - 120000)), 'FRESH_READBACK_REQUIRED');
  requireProof(['controllerStateSha256', 'rawJournalSha256', 'commandJournalSha256'].every((key) => sha256.test(proof[key])),
    'ARCHIVE_HASHES_REQUIRED');
  requireProof(sameInventory(proof.baseline, proof.finalInventory) && sameInventory(proof.baseline, proof.currentInventory),
    'INVENTORY_OR_COUNTER_CHANGED');
}

export function verifyFailedStartArchives(proof, archives) {
  validateProofShape(proof, Date.now(), false);
  for (const [key, hashKey] of [
    ['state', 'controllerStateSha256'], ['raw', 'rawJournalSha256'], ['command', 'commandJournalSha256'],
  ]) {
    const bytes = archives[key];
    requireProof(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024
      && createHash('sha256').update(bytes).digest('hex') === proof[hashKey].toLowerCase(),
    'PRESERVED_ARCHIVE_HASH_MISMATCH');
  }
  const state = normalizeKeys(JSON.parse(archives.state.toString('utf8')));
  const command = normalizeKeys(JSON.parse(archives.command.toString('utf8')));
  const intake = state.intake;
  requireProof(state.streamId === proof.streamId && state.deviceId === proof.deviceId
    && state.acknowledgedSequence === proof.acknowledgedSequence && state.nextSequence === proof.nextSequence
    && state.pollInFlight === false && Array.isArray(state.outbox) && state.outbox.length === 0
    && state.locked === true && sameReasons(state.lockReasons, reasons),
  'ARCHIVED_CONTROLLER_STATE_MISMATCH');
  requireProof(intake && intake.started === false && intake.closed === true && intake.disabledObserved === true
    && intake.enableDispatchStarted === true && intake.disableDispatchStarted === true
    && intake.deadline === null && Array.isArray(intake.notes) && intake.notes.length === 0
    && intake.closeReason === 'fault' && sameReasons(intake.reasons, reasons)
    && sameInventory(intake.baseline, proof.baseline) && sameInventory(intake.finalInventory, proof.finalInventory),
  'ARCHIVED_INTAKE_NOT_FAILED_START_ZERO');
  for (const item of [intake.command, command.command]) {
    requireProof(item?.commandId === proof.commandId && item.atmId === proof.atmId && item.visitId === proof.visitId
      && item.cashSessionId === proof.cashSessionId && item.type === 'start_cash', 'ARCHIVED_COMMAND_BINDING_MISMATCH');
  }
  requireProof(command.state === 'unknown' && command.reason === 'acceptance_state_not_observed'
    && command.observation === null && command.pendingReportState === null,
  'ARCHIVED_COMMAND_NOT_TERMINAL_UNKNOWN');
  return {
    proofHash: cashEvidenceHash(proof),
    command: command.command,
    archiveHashes: {
      controllerStateSha256: proof.controllerStateSha256.toLowerCase(),
      rawJournalSha256: proof.rawJournalSha256.toLowerCase(),
      commandJournalSha256: proof.commandJournalSha256.toLowerCase(),
    },
  };
}

export function validateFailedStartZeroReconciliation(evidence, proof, verifiedArchives, now = Date.now()) {
  validateProofShape(proof, now);
  requireProof(verifiedArchives?.proofHash === cashEvidenceHash(proof), 'PRESERVED_ARCHIVES_REQUIRED');
  const { atm, visit, session, command, stream, consent, budget, events } = evidence;
  requireProof(atm?.id === proof.atmId && atm.activeVisitId === proof.visitId && atm.cashEnabled === false
    && atm.cashReconciliationRequired === true && atm.cashStreamId === proof.streamId
    && atm.controllerHealth?.deviceId === proof.deviceId, 'CURRENT_ATM_BINDING_OR_DISABLED_GATE_MISMATCH');
  requireProof(visit?.id === proof.visitId && visit.atmId === atm.id && visit.templeId === atm.templeId
    && visit.mode === 'cash' && visit.cashSessionId === proof.cashSessionId
    && ['reconciling', 'needs_reconciliation'].includes(visit.state)
    && visit.cashAcceptedPaise === '0' && visit.cashDeadline === null && !visit.acceptingAt
    && !visit.donationId && visit.cashCloseRequested === true && visit.cashCloseReason === 'fault'
    && visit.reconciliationReason === 'acceptance_state_not_observed'
    && sameReasons(visit.reconciliationReasons, ledgerReasons), 'CURRENT_VISIT_NOT_FAILED_START_ZERO');
  requireProof(session?.atmId === atm.id && session.visitId === visit.id && session.cashSessionId === proof.cashSessionId
    && session.streamId === proof.streamId && session.ledger?.closed === true && session.ledger.baseline === null
    && Array.isArray(session.ledger.notes) && session.ledger.notes.length === 0
    && sameReasons(session.ledger.reconciliationReasons, ledgerReasons), 'CURRENT_LEDGER_NOT_FAILED_START_ZERO');
  requireProof(command?.commandId === proof.commandId && command.type === 'start_cash'
    && command.state === 'unknown' && command.reason === 'acceptance_state_not_observed'
    && command.atmId === atm.id && command.visitId === visit.id && command.templeId === visit.templeId
    && command.cashSessionId === proof.cashSessionId && !command.observedAt && !command.deviceState,
  'ORIGINAL_COMMAND_NOT_TERMINAL_UNKNOWN');
  const archivedCommand = verifiedArchives.command;
  requireProof(archivedCommand?.expiresAt === command.expiresAt && archivedCommand.createdAt === command.createdAt
    && archivedCommand.templeId === command.templeId, 'ARCHIVED_COMMAND_CONTENT_MISMATCH');
  requireProof(consent?.used === true && consent.visitId === visit.id && consent.cashSessionId === proof.cashSessionId
    && consent.atmId === atm.id && consent.templeId === visit.templeId
    && typeof consent.wallet === 'string' && typeof visit.ownerWallet === 'string'
    && consent.wallet.toLowerCase() === visit.ownerWallet.toLowerCase(), 'USED_CONSENT_BINDING_MISMATCH');
  requireProof(!evidence.donation && !evidence.job && evidence.otherDonationCount === 0
    && evidence.rejectedCount === 0 && !session.failedStartReconciliationId, 'CONFLICTING_EVIDENCE_OR_SETTLEMENT');
  requireProof(stream?.lastSequence === proof.acknowledgedSequence
    && budget?.pendingPaise === '0' && budget?.pendingNotes === 0, 'STREAM_OR_PENDING_BUDGET_CONFLICT');
  requireProof(Array.isArray(events) && events.length === 3, 'EXACT_FAILED_START_EVENT_SET_REQUIRED');
  const ordered = events.map((row) => ({ ...row, event: validateCashEvent(row.event) }))
    .sort((a, b) => a.event.sequence - b.event.sequence);
  for (const [index, row] of ordered.entries()) {
    const event = row.event;
    requireProof(event.cashSessionId === proof.cashSessionId && event.visitId === proof.visitId
      && event.streamId === proof.streamId && event.deviceEventId === row.id
      && event.sequence === proof.acknowledgedSequence - 2 + index
      && row.payloadHash === cashEvidenceHash(event)
      && Number.isSafeInteger(row.receivedAt) && row.receivedAt > 0
      && (index === 0 || ordered[index - 1].event.occurredAt <= event.occurredAt),
    'FAILED_START_EVENT_BINDING_OR_ORDER_MISMATCH');
    if (index < 2) requireProof(event.type === 'needs_reconciliation' && event.data.reason === reasons[index],
      'UNEXPECTED_FAILED_START_EVENT');
  }
  const close = ordered[2].event;
  requireProof(close.type === 'intake_closed' && close.data.reason === 'fault' && close.data.disabled === true
    && close.data.escrowEmpty === true && close.data.creditedNotes === 0 && close.data.creditedPaise === '0'
    && close.data.uncreditedNotes === 0 && sameReasons(close.data.reconciliationReasons, reasons)
    && sameInventory(close.data.inventory, proof.baseline)
    && stream.lastOccurredAt === close.occurredAt && proof.observedAt >= close.occurredAt,
  'AUTHENTICATED_CLOSE_OR_PHYSICAL_READBACK_MISMATCH');
  return {
    proofHash: verifiedArchives.proofHash,
    result: 'failed_start_zero_reconciled', cashSessionId: proof.cashSessionId, visitId: proof.visitId,
    atmId: proof.atmId, commandId: proof.commandId, streamId: proof.streamId,
    acknowledgedSequence: proof.acknowledgedSequence, donationCreated: false, mintCreated: false,
    cashEnabled: false, originalCommandState: 'unknown',
  };
}

export async function reconcileFailedCashStart(db, proof, archives, { apply = false, now = Date.now() } = {}) {
  const verified = verifyFailedStartArchives(proof, archives);
  const atmRef = db.collection('atms').doc(proof.atmId);
  const visitRef = db.collection('visits').doc(proof.visitId);
  const sessionRef = db.collection('cashSessions').doc(proof.cashSessionId);
  const archiveRef = db.collection('cashFailedStartReconciliations').doc(proof.cashSessionId);
  const donationId = cashDonationId(proof.atmId, proof.cashSessionId);
  return db.runTransaction(async (tx) => {
    const refs = {
      atm: atmRef, visit: visitRef, session: sessionRef, archive: archiveRef,
      command: db.collection('controllerCommands').doc(proof.commandId),
      stream: atmRef.collection('cashStreams').doc(proof.streamId),
      budget: db.collection('cashBudgets').doc('demo'),
      donation: db.collection('donations').doc(donationId), job: db.collection('mintJobs').doc(donationId),
    };
    const entries = await Promise.all(Object.entries(refs).map(async ([name, ref]) => [name, (await tx.get(ref)).data()]));
    const evidence = Object.fromEntries(entries);
    if (evidence.archive) {
      requireProof(evidence.archive.proofHash === verified.proofHash, 'RECONCILIATION_REPLAY_MISMATCH');
      requireProof(evidence.command?.state === 'unknown' && evidence.session?.failedStartReconciliationId === proof.cashSessionId
        && evidence.visit?.state === 'closed', 'RECONCILIATION_REPLAY_STATE_MISMATCH');
      return { ...evidence.archive.result, applied: true, duplicate: true };
    }
    requireProof(/^[a-f0-9]{48}$/.test(evidence.visit?.cashConsentChallenge ?? ''), 'USED_CONSENT_REQUIRED');
    const [consent, events, rejected, donations] = await Promise.all([
      tx.get(db.collection('cashConsentChallenges').doc(evidence.visit.cashConsentChallenge)),
      tx.get(atmRef.collection('cashEvents').where('event.cashSessionId', '==', proof.cashSessionId).limit(4)),
      tx.get(atmRef.collection('cashRejectedEvents').limit(1)),
      tx.get(db.collection('donations').where('cashSessionId', '==', proof.cashSessionId).limit(1)),
    ]);
    Object.assign(evidence, {
      consent: consent.data(), events: events.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      rejectedCount: rejected.size, otherDonationCount: donations.size,
    });
    const result = validateFailedStartZeroReconciliation(evidence, proof, verified, now);
    if (!apply) return { ...result, applied: false, dryRun: true };
    tx.create(archiveRef, {
      version: proof.version, proofHash: verified.proofHash, proof, archiveHashes: verified.archiveHashes,
      originalCommand: evidence.command, originalSession: evidence.session,
      originalVisitState: {
        state: evidence.visit.state, cashCloseReason: evidence.visit.cashCloseReason,
        reconciliationReason: evidence.visit.reconciliationReason,
        reconciliationReasons: evidence.visit.reconciliationReasons,
      },
      originalAtmState: {
        activeVisitId: evidence.atm.activeVisitId, cashEnabled: evidence.atm.cashEnabled,
        cashReconciliationRequired: evidence.atm.cashReconciliationRequired, cashStreamId: evidence.atm.cashStreamId,
      },
      acceptedEvents: evidence.events, reconciledAt: now, result,
    });
    tx.update(sessionRef, { failedStartReconciliationId: proof.cashSessionId, failedStartReconciledAt: now });
    tx.update(visitRef, { state: 'closed', closedAt: now, failedStartReconciliationId: proof.cashSessionId });
    tx.update(atmRef, {
      activeVisitId: null, cashReconciliationRequired: false, cashEnabled: false,
      lastFailedStartReconciliationId: proof.cashSessionId,
    });
    return { ...result, applied: true, duplicate: false };
  });
}

async function main(args) {
  const allowed = ['--proof', '--state-archive', '--raw-archive', '--command-archive', '--apply'];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireProof(allowed.includes(key) && !Object.hasOwn(options, key), 'INVALID_ARGUMENTS');
    options[key] = key === '--apply' ? true : args[++index];
  }
  requireProof(allowed.slice(0, 4).every((key) => typeof options[key] === 'string' && options[key].length > 0), 'ARCHIVE_PATHS_REQUIRED');
  const { checkPolicy } = await import('./check-policy.mjs');
  checkPolicy();
  requireProof(!process.env.FIRESTORE_EMULATOR_HOST, 'REAL_PROJECT_REQUIRED');
  const read = (path) => {
    requireProof(statSync(path).size <= 32 * 1024 * 1024, 'ARCHIVE_TOO_LARGE');
    return readFileSync(path);
  };
  const proof = JSON.parse(read(options['--proof']).toString('utf8'));
  const archives = { state: read(options['--state-archive']), raw: read(options['--raw-archive']), command: read(options['--command-archive']) };
  verifyFailedStartArchives(proof, archives);
  const firebase = JSON.parse(readFileSync(join('config', 'firebase.public.json'), 'utf8'));
  requireProof(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === firebase.projectId, 'PROJECT_MISMATCH');
  const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId: firebase.projectId }, `cash-zero-reconcile-${process.pid}`);
  const db = getFirestore(app);
  try {
    console.log(JSON.stringify(await reconcileFailedCashStart(db, proof, archives, { apply: options['--apply'] === true })));
  } finally { await db.terminate(); await deleteApp(app); }
}
if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'RECONCILIATION_NOT_VERIFIED';
    console.log(JSON.stringify({
      result: code === 'RECONCILIATION_NOT_VERIFIED' ? 'unknown' : 'rejected', code,
      applied: code === 'RECONCILIATION_NOT_VERIFIED' && process.argv.includes('--apply') ? 'unknown' : false,
    }));
    process.exitCode = 1;
  }
}
