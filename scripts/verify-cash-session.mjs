import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient, getAddress, http, keccak256, parseEventLogs, toHex,
  TransactionReceiptNotFoundError,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { ATM_ID, CASH_ACCEPTANCE_MS, cashMachineStatus, VISIT_REFERENCE } from '../src/atm.ts';
import {
  CASH_DEMO_LIMIT_PAISE, CASH_DEMO_NOTE_LIMIT, applyCashEvent, cashTotals,
  newCashLedger, validateCashEvent,
} from '../src/cash.ts';
import { CHAIN_ID, donationPointUnits, stampAbi } from '../src/shared.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const MAX_EVENTS = 2000;
const MAX_DONATIONS = 500;
const equalAddress = (a, b) => typeof a === 'string' && address.test(a)
  && typeof b === 'string' && address.test(b) && a.toLowerCase() === b.toLowerCase();
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const cashEvidenceHash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export const cashDonationId = (atmId, cashSessionId) => `0x${cashEvidenceHash({ purpose: 'cash-donation-v1', atmId, cashSessionId })}`;
function unsigned(value) {
  return typeof value === 'string' && /^(0|[1-9]\d{0,30})$/.test(value) ? BigInt(value) : null;
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;
function summary(status, checks, fields = {}) {
  return {
    mode: 'cash-session', status, confirmed: status === 'confirmed', checks, ...fields,
    exitCode: status === 'confirmed' ? 0 : status === 'mismatch' ? 1 : 2,
  };
}
export function assessCashPreflight(atmId, atm, budget, now = Date.now()) {
  const amounts = ['storedPaise', 'pendingPaise'].map((field) => unsigned(budget ? budget[field] : '0'));
  const notes = ['storedNotes', 'pendingNotes'].map((field) => budget ? budget[field] : 0);
  const validBudget = amounts.every((value) => value !== null) && notes.every(count);
  const canFitOne100Inr = validBudget && amounts[0] + amounts[1] + 10000n <= BigInt(CASH_DEMO_LIMIT_PAISE)
    && notes[0] + notes[1] + 1 <= CASH_DEMO_NOTE_LIMIT;
  const registrationChangesRequired = [];
  if (!atm || atm.id !== atmId || !ATM_ID.test(atmId)) registrationChangesRequired.push('atm_registration');
  if (atm?.templeId !== 'temple-01') registrationChangesRequired.push('onsite_temple_binding');
  if (atm?.enabled !== true) registrationChangesRequired.push('enabled');
  if (!/^[a-f0-9]{64}$/.test(atm?.credentialHash ?? '')) registrationChangesRequired.push('controller_credential_registration');
  if (atm?.cashEnabled !== true) registrationChangesRequired.push('cashEnabled');
  return {
    mode: 'preflight', status: validBudget && atm ? 'read_only_checked' : 'unknown',
    atmId: ATM_ID.test(atmId) ? atmId : null, budgetExists: Boolean(budget),
    storedPaise: amounts[0]?.toString() ?? null, pendingPaise: amounts[1]?.toString() ?? null,
    storedNotes: count(notes[0]) ? notes[0] : null, pendingNotes: count(notes[1]) ? notes[1] : null,
    canFitOne100Inr, registrationChangesRequired,
    cashEnabled: atm?.cashEnabled === true, activeReception: Boolean(atm?.activeVisitId),
    reconciliationLocked: atm?.cashReconciliationRequired === true,
    controllerReady: cashMachineStatus(atm?.controllerHealth ?? null, now) === 'ready',
    physicalPermissionGrantedByVerifier: false,
    exitCode: validBudget && atm && canFitOne100Inr ? 0 : 2,
  };
}

export function verifyCashEvidence(evidence) {
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); return Boolean(ok); };
  const fields = { cashSessionId: uuid.test(evidence.cashSessionId ?? '') ? evidence.cashSessionId : null };
  const fail = () => summary('mismatch', checks, fields);
  try {
    if (!check('cash_session_id', fields.cashSessionId)) return fail();
    const { session, atm, visit, consent, command, stream, donation, job, total } = evidence;
    if (!session) return summary('not_confirmed', checks, { ...fields, reason: 'cash_session_not_recorded' });
    if (!check('session_binding', session.cashSessionId === fields.cashSessionId && ATM_ID.test(session.atmId ?? '')
      && VISIT_REFERENCE.test(session.visitId ?? '') && uuid.test(session.streamId ?? ''))) return fail();
    Object.assign(fields, { atmId: session.atmId, visitId: session.visitId, streamId: session.streamId });
    if (!check('atm_visit_attribution', atm?.id === session.atmId && visit?.id === session.visitId
      && visit.atmId === atm.id && visit.templeId === atm.templeId && visit.mode === 'cash'
      && visit.cashSessionId === session.cashSessionId && address.test(visit.ownerWallet ?? ''))) return fail();
    check('registered_controller', /^[a-f0-9]{64}$/.test(atm.credentialHash ?? ''));
    check('single_used_consent', consent?.used === true && consent.visitId === visit.id
      && consent.cashSessionId === session.cashSessionId && consent.atmId === atm.id
      && consent.templeId === visit.templeId && equalAddress(consent.wallet, visit.ownerWallet)
      && visit.cashConsentVersion === 'cash-session-v1');
    check('observed_start_command', command?.commandId === `cash-start-${session.cashSessionId}`
      && command.type === 'start_cash' && command.atmId === atm.id && command.visitId === visit.id
      && command.cashSessionId === session.cashSessionId && command.templeId === visit.templeId
      && ['observed', 'reported'].includes(command.state) && command.deviceState === 'ACCEPTING'
      && Number.isSafeInteger(command.observedAt) && command.observedAt > 0);
    check('finite_ready_deadline', Number.isSafeInteger(visit.acceptingAt) && visit.acceptingAt > 0
      && visit.cashDeadline === visit.acceptingAt + CASH_ACCEPTANCE_MS
      && visit.acceptingAt <= command?.observedAt);
    if (evidence.truncated) return summary('unknown', checks, { ...fields, reason: 'bounded_query_limit' });
    const events = (evidence.events ?? []).map((row) => ({ ...row, event: validateCashEvent(row.event) }))
      .sort((a, b) => a.event.sequence - b.event.sequence);
    if (!events.length) return summary('not_confirmed', checks, { ...fields, reason: 'no_accepted_events' });
    const first = events[0].event;
    const last = events.at(-1).event;
    check('stream_resumption', atm.cashStreamId === session.streamId && count(stream?.lastSequence)
      && stream.lastSequence >= last.sequence && Number.isSafeInteger(stream.lastOccurredAt)
      && stream.lastOccurredAt >= last.occurredAt);
    const predecessor = evidence.predecessor;
    const previousEvent = first.sequence > 1 && predecessor ? validateCashEvent(predecessor.event) : null;
    check('stream_predecessor', first.sequence === 1 || (previousEvent
      && previousEvent.type === 'intake_closed' && previousEvent.data.disabled && previousEvent.data.escrowEmpty
      && previousEvent.streamId === session.streamId && previousEvent.sequence === first.sequence - 1
      && predecessor.id === previousEvent.deviceEventId && previousEvent.occurredAt <= first.occurredAt
      && predecessor.payloadHash === cashEvidenceHash(previousEvent)));
    check('start_baseline_first', first.type === 'intake_started' && first.occurredAt >= command.observedAt);
    let replay = newCashLedger();
    let ordered = true;
    let attributed = true;
    let payloads = true;
    let stopSafe = true;
    let lastAt = first.occurredAt;
    let closed = false;
    for (const [index, row] of events.entries()) {
      const event = row.event;
      ordered &&= event.sequence === first.sequence + index && event.occurredAt >= lastAt && !closed;
      attributed &&= event.cashSessionId === session.cashSessionId && event.visitId === visit.id
        && event.streamId === session.streamId && row.id === event.deviceEventId;
      payloads &&= row.payloadHash === cashEvidenceHash(event) && Number.isSafeInteger(row.receivedAt) && row.receivedAt > 0;
      if (event.type === 'note_escrow' && event.data.decision === 'accept') {
        stopSafe &&= event.occurredAt < visit.cashDeadline
          && (!visit.cashCloseRequestedAt || event.occurredAt < visit.cashCloseRequestedAt);
      }
      if (event.type === 'intake_closed') {
        closed = true;
        if (event.data.reason === 'done') stopSafe &&= visit.cashCloseRequested === true && Number.isSafeInteger(visit.cashCloseRequestedAt);
        if (event.data.reason === 'deadline') stopSafe &&= event.occurredAt >= visit.cashDeadline;
      }
      replay = applyCashEvent(replay, event);
      lastAt = event.occurredAt;
    }
    check('continuous_ordered_events', ordered);
    check('bound_event_attribution', attributed);
    check('persisted_payload_hashes', payloads);
    check('stop_and_deadline_observed', stopSafe);
    check('no_rejected_evidence', (evidence.rejectedCount ?? 0) === 0 && !atm.cashReconciliationRequired
      && !['reconciling', 'needs_reconciliation'].includes(visit.state));
    check('stored_ledger_matches_replay', canonical(session.ledger) === canonical(replay));
    const totals = cashTotals(replay);
    Object.assign(fields, {
      acceptedEvents: events.length, storedNotes: totals.storedNotes, creditedNotes: totals.creditedNotes,
      storedPaise: totals.storedPaise.toString(), creditedPaise: totals.creditedPaise.toString(),
    });
    check('stored_amount_matches_visit', visit.cashAcceptedPaise === totals.storedPaise.toString());
    if (checks.some((item) => !item.ok)) return fail();
    if (!replay.closed) {
      check('no_premature_settlement', !donation && !job && !visit.donationId);
      return checks.some((item) => !item.ok) ? fail() : summary('not_confirmed', checks, { ...fields, reason: 'intake_not_closed' });
    }
    check('physical_close_reconciled', replay.reconciliationReasons.length === 0);
    if (checks.some((item) => !item.ok)) return fail();
    if (totals.creditedPaise === 0n) {
      check('zero_without_donation_or_mint', visit.state === 'closed' && !visit.donationId && !donation && !job);
      return checks.some((item) => !item.ok) ? fail()
        : summary('not_confirmed', checks, { ...fields, reason: 'closed_zero_no_donation' });
    }
    const id = cashDonationId(atm.id, session.cashSessionId);
    fields.donationId = id;
    const amount = totals.creditedPaise * 100n;
    const fee = amount * 3n / 100n;
    const templeKey = keccak256(toHex(visit.templeId));
    check('deterministic_cash_donation', donation?.id === id && visit.donationId === id
      && ['confirmed', 'closed'].includes(visit.state) && donation.status === 'confirmed'
      && donation.paymentMethod === 'cash' && donation.chainId === null && donation.txHash === null
      && donation.cashSessionId === session.cashSessionId && donation.onsiteVisitId === visit.id
      && donation.templeId === visit.templeId && donation.templeKey === templeKey && donation.kind === 1
      && equalAddress(donation.ownerWallet, visit.ownerWallet));
    check('cash_amount_and_unpaid_fee', donation?.cashAmountPaise === totals.creditedPaise.toString()
      && donation.amount === amount.toString() && donation.fee === fee.toString()
      && donation.net === (amount - fee).toString() && donation.cashFeeStatus === 'unpaid');
    check('registered_temple_recipient', equalAddress(donation?.recipient, evidence.registeredRecipient));
    const confirmedAt = Date.parse(donation?.confirmedAt ?? '');
    check('existing_mint_reservation', job?.donationId === id && equalAddress(job.ownerWallet, visit.ownerWallet)
      && job.templeKey === templeKey && job.kind === 1 && Number.isFinite(confirmedAt)
      && job.day === Math.floor(confirmedAt / 86_400_000).toString()
      && ['reserved', 'prepared', 'submitted', 'minted', 'error'].includes(job.status));
    const donations = evidence.walletDonations ?? [];
    let sum = 0n;
    let matchingDonationCount = 0;
    const ids = new Set();
    for (const row of donations) {
      if (!hash.test(row.id ?? '') || ids.has(row.id)) { check('unique_wallet_donations', false); return fail(); }
      ids.add(row.id);
      if (row.id === id) matchingDonationCount++;
      if (!equalAddress(row.ownerWallet, visit.ownerWallet)) { check('wallet_query_attribution', false); return fail(); }
      if (row.status !== 'confirmed' || row.templeId !== visit.templeId) continue;
      const units = unsigned(row.amount);
      if (units === null || ![0, 1].includes(row.kind)) { check('valid_point_sources', false); return fail(); }
      sum += donationPointUnits(units, row.kind);
    }
    check('exact_owner_temple_points', matchingDonationCount === 1 && total?.wallet === visit.ownerWallet.toLowerCase()
      && total.templeId === visit.templeId && total.points === sum.toString());
    fields.pointUnits = sum.toString();
    if (checks.some((item) => !item.ok)) return fail();
    return summary('pending', checks, { ...fields, reason: 'canonical_mint_receipt_required' });
  } catch {
    check('well_formed_evidence', false);
    return fail();
  }
}

export function verifyMintReceiptEvidence(report, { receipt, block, chainId, donation, job, stamp, minter }) {
  if (report.status !== 'pending') return report;
  const checks = [...report.checks];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  if (!receipt) return summary('pending', checks, { ...report, status: 'pending', confirmed: false, exitCode: 2, reason: 'mint_receipt_not_found' });
  try {
    check('expected_chain', chainId === CHAIN_ID);
    check('bound_successful_receipt', hash.test(job.txHash ?? '') && donation.mintTxHash === job.txHash
      && receipt.transactionHash === job.txHash && receipt.status === 'success'
      && equalAddress(receipt.to, stamp) && equalAddress(receipt.from, minter));
    check('canonical_mint_block', block?.hash === receipt.blockHash && block?.number === receipt.blockNumber);
    const logs = receipt.logs.filter((log) => equalAddress(log.address, stamp));
    const events = parseEventLogs({ abi: stampAbi, eventName: 'StampMinted', logs, strict: true });
    const transfers = parseEventLogs({ abi: stampAbi, eventName: 'TransferSingle', logs, strict: true });
    check('exact_stamp_and_transfer_count', events.length === 1 && transfers.length === 1);
    const expectedTokenId = BigInt(job.donationId);
    const minted = events[0]?.args;
    const transfer = transfers[0]?.args;
    check('exact_stamp_event', minted?.donationId === job.donationId && equalAddress(minted.recipient, job.ownerWallet)
      && minted.tokenId === expectedTokenId && minted.templeId === job.templeKey && minted.kind === 1 && minted.day === BigInt(job.day));
    check('exact_erc1155_mint', transfer?.from === '0x0000000000000000000000000000000000000000'
      && equalAddress(transfer.to, job.ownerWallet) && equalAddress(transfer.operator, minter)
      && transfer.id === expectedTokenId && transfer.value === 1n);
    check('canonical_log_context', [...events, ...transfers].every((log) => !log.removed
      && log.transactionHash === receipt.transactionHash && log.blockHash === receipt.blockHash
      && log.blockNumber === receipt.blockNumber));
    if (checks.some((item) => !item.ok)) {
      return { ...report, status: 'mismatch', confirmed: false, checks, exitCode: 1, reason: 'mint_receipt_mismatch' };
    }
    const persisted = donation.mintStatus === 'minted' && job.status === 'minted'
      && donation.tokenId === expectedTokenId.toString();
    check('mint_completion_persisted', persisted);
    return {
      ...report, status: persisted ? 'confirmed' : 'pending', confirmed: persisted, checks,
      mintTxHash: job.txHash, mintBlock: receipt.blockNumber.toString(),
      reason: persisted ? 'cash_and_canonical_mint_verified' : 'mint_completion_not_persisted',
      exitCode: persisted ? 0 : 2,
    };
  } catch {
    check('well_formed_mint_evidence', false);
    return { ...report, status: 'mismatch', confirmed: false, checks, exitCode: 1, reason: 'malformed_mint_evidence' };
  }
}

async function loadCashEvidence(db, cashSessionId, registeredWallets) {
  const tracked = [];
  const version = (snapshot) => snapshot.updateTime
    ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : null;
  const get = async (ref) => {
    const snapshot = await ref.get();
    tracked.push({ ref, revision: version(snapshot) });
    return snapshot.data();
  };
  const session = await get(db.collection('cashSessions').doc(cashSessionId));
  if (!session) return { cashSessionId, session };
  if (!ATM_ID.test(session.atmId ?? '') || !VISIT_REFERENCE.test(session.visitId ?? '') || !uuid.test(session.streamId ?? '')) {
    return { cashSessionId, session };
  }
  const atmRef = db.collection('atms').doc(session.atmId);
  const [atm, visit, stream, command, eventRows, rejectedRows] = await Promise.all([
    get(atmRef), get(db.collection('visits').doc(session.visitId)),
    get(atmRef.collection('cashStreams').doc(session.streamId)),
    get(db.collection('controllerCommands').doc(`cash-start-${cashSessionId}`)),
    atmRef.collection('cashEvents').where('event.cashSessionId', '==', cashSessionId).limit(MAX_EVENTS + 1).get(),
    atmRef.collection('cashRejectedEvents').limit(1).get(),
  ]);
  const events = eventRows.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const first = events.slice().sort((a, b) => a.event?.sequence - b.event?.sequence)[0]?.event;
  const predecessorId = count(first?.sequence) && first.sequence > 1 ? `${session.streamId}:${first.sequence - 1}` : null;
  const predecessor = predecessorId ? { id: predecessorId, ...await get(atmRef.collection('cashEvents').doc(predecessorId)) } : null;
  const id = cashDonationId(session.atmId, cashSessionId);
  const validOwner = address.test(visit?.ownerWallet ?? '');
  const [consent, donation, job, total, walletRows] = await Promise.all([
    /^[a-f0-9]{48}$/.test(visit?.cashConsentChallenge ?? '')
      ? get(db.collection('cashConsentChallenges').doc(visit.cashConsentChallenge)) : null,
    get(db.collection('donations').doc(id)), get(db.collection('mintJobs').doc(id)),
    validOwner ? get(db.collection('walletTempleTotals').doc(`${visit.ownerWallet.toLowerCase()}_${visit.templeId}`)) : null,
    validOwner ? db.collection('donations').where('ownerWallet', '==', getAddress(visit.ownerWallet))
      .select('id', 'ownerWallet', 'templeId', 'status', 'amount', 'kind').limit(MAX_DONATIONS + 1).get() : null,
  ]);
  return {
    cashSessionId, session, atm, visit, stream, command, events, consent, donation, job, total, predecessor,
    rejectedCount: rejectedRows.size,
    registeredRecipient: registeredWallets[visit?.templeId],
    walletDonations: walletRows?.docs.map((doc) => ({ ...doc.data(), id: doc.id })) ?? [],
    truncated: eventRows.size > MAX_EVENTS || (walletRows?.size ?? 0) > MAX_DONATIONS,
    unchanged: async () => (await Promise.all(tracked.map(async ({ ref, revision }) => {
      const current = await ref.get();
      return version(current) === revision;
    }))).every(Boolean),
  };
}

export async function main(args = process.argv.slice(2)) {
  const preflight = args[0] === '--preflight' && args.length === 2 && ATM_ID.test(args[1]);
  const cashSessionId = args.length === 1 && uuid.test(args[0]) ? args[0] : null;
  if (!preflight && !cashSessionId) {
    console.log(JSON.stringify({ status: 'unknown', reason: 'usage: verify-cash-session.mjs CASH_SESSION_UUID | --preflight ATM_ID', exitCode: 2 }));
    return 2;
  }
  let db;
  let app;
  let deleteApp;
  try {
    const { checkPolicy } = await import('./check-policy.mjs');
    checkPolicy();
    if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('REAL_FIRESTORE_REQUIRED');
    const firebase = JSON.parse(readFileSync(join('config', 'firebase.public.json'), 'utf8'));
    if (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== firebase.projectId) throw new Error('PROJECT_MISMATCH');
    const admin = await import('firebase-admin/app');
    deleteApp = admin.deleteApp;
    app = admin.initializeApp({ credential: admin.applicationDefault(), projectId: firebase.projectId }, `cash-verifier-${process.pid}`);
    const { getFirestore } = await import('firebase-admin/firestore');
    db = getFirestore(app);
    let result;
    if (preflight) {
      const [atm, budget] = await Promise.all([
        db.collection('atms').doc(args[1]).get(), db.collection('cashBudgets').doc('demo').get(),
      ]);
      result = assessCashPreflight(args[1], atm.data(), budget.data());
    } else {
      const wallets = JSON.parse(readFileSync(join('config', 'wallets.public.json'), 'utf8'));
      const evidence = await loadCashEvidence(db, cashSessionId, wallets.wallets);
      result = verifyCashEvidence(evidence);
      if (result.status === 'pending') {
        const deployment = JSON.parse(readFileSync(join('config', 'deployment.public.json'), 'utf8'));
        if (deployment.chainId !== CHAIN_ID || !address.test(deployment.stamp) || !address.test(wallets.wallets?.minter ?? '')) {
          throw new Error('PUBLIC_DEPLOYMENT_MISMATCH');
        }
        if (!hash.test(evidence.job.txHash ?? '')) {
          result = { ...result, reason: 'mint_transaction_not_recorded' };
        } else {
          const chain = createPublicClient({
            chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org', { timeout: 10000, retryCount: 0 }),
          });
          let receipt = null;
          try { receipt = await chain.getTransactionReceipt({ hash: evidence.job.txHash }); }
          catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
          const [chainId, block] = await Promise.all([
            chain.getChainId(), receipt ? chain.getBlock({ blockNumber: receipt.blockNumber }) : null,
          ]);
          result = verifyMintReceiptEvidence(result, {
            receipt, block, chainId, donation: evidence.donation, job: evidence.job,
            stamp: deployment.stamp, minter: wallets.wallets.minter,
          });
        }
      }
      if (evidence.unchanged && !await evidence.unchanged()) {
        result = { ...result, status: 'unknown', confirmed: false, exitCode: 2, reason: 'evidence_changed_during_read_retry_read_only' };
      }
    }
    console.log(JSON.stringify({
      source: 'live_firestore_read_only', attribution: 'persisted_central_binding_not_independent_hardware_proof', ...result,
    }));
    return result.exitCode;
  } catch {
    console.log(JSON.stringify({
      mode: preflight ? 'preflight' : 'cash-session', status: 'unknown', confirmed: false,
      ...(cashSessionId ? { cashSessionId } : {}), reason: 'policy_configuration_or_read_failed', exitCode: 2,
    }));
    return 2;
  } finally {
    if (db) await db.terminate().catch(() => undefined);
    if (app) await deleteApp(app).catch(() => undefined);
  }
}
if (import.meta.main) process.exitCode = await main();
