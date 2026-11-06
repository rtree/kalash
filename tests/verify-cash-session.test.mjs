import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import {
  assessCashPreflight, cashDonationId, cashEvidenceHash, verifyCashEvidence, verifyMintReceiptEvidence,
} from '../scripts/verify-cash-session.mjs';
import { CASH_DENOMINATIONS, applyCashEvent, newCashLedger } from '../src/cash.ts';
import { stampAbi } from '../src/shared.ts';

// Pure synthetic evidence only: these cases never read Firestore, RPC or hardware.
const owner = `0x${'11'.repeat(20)}`;
const minter = `0x${'22'.repeat(20)}`;
const stamp = `0x${'33'.repeat(20)}`;
const recipient = `0x${'44'.repeat(20)}`;
const cashSessionId = '10000000-0000-4000-8000-000000000001';
const streamId = '20000000-0000-4000-8000-000000000001';
const visitId = 'a'.repeat(64);
const txHash = `0x${'bb'.repeat(32)}`;
const blockHash = `0x${'cc'.repeat(32)}`;
const now = Date.parse('2026-11-06T18:00:00Z');
const templeKey = keccak256(toHex('temple-01'));
function inventory(notes = 0) {
  return {
    levels: CASH_DENOMINATIONS.map((valuePaise) => ({ valuePaise, payout: valuePaise === '10000' ? notes : 0, cashbox: 0 })),
    counters: { stored: notes, stacked: 0, dispensed: 0, transferredToStack: 0 },
  };
}
function fixture() {
  const donationId = cashDonationId('atm-01', cashSessionId);
  const note = { noteKey: 'fixture-note-1', valuePaise: '10000', currency: 'INR' };
  const rawEvents = [
    { type: 'intake_started', data: { inventory: inventory() } },
    { type: 'note_escrow', data: { ...note, decision: 'accept' } },
    { type: 'note_stored', data: { ...note, route: 'payout' } },
    { type: 'intake_closed', data: {
      reason: 'done', inventory: inventory(1), creditedPaise: '10000', creditedNotes: 1, uncreditedNotes: 0,
      disabled: true, escrowEmpty: true, reconciliationReasons: [],
    } },
  ].map((part, i) => ({
    streamId, sequence: i + 1, deviceEventId: `${streamId}:${i + 1}`,
    occurredAt: now + i * 1000, visitId, cashSessionId, ...part,
  }));
  const ledger = rawEvents.reduce(applyCashEvent, newCashLedger());
  const donation = {
    id: donationId, ownerWallet: owner, templeId: 'temple-01', templeKey, kind: 1, onsiteVisitId: visitId,
    paymentMethod: 'cash', chainId: null, txHash: null, cashSessionId, cashAmountPaise: '10000',
    cashFeeStatus: 'unpaid', amount: '1000000', fee: '30000', net: '970000',
    recipient, status: 'confirmed', mintStatus: 'minted', mintTxHash: txHash, tokenId: BigInt(donationId).toString(),
    confirmedAt: new Date(now + 3100).toISOString(),
  };
  return {
    cashSessionId, registeredRecipient: recipient,
    session: { atmId: 'atm-01', visitId, cashSessionId, streamId, ledger },
    atm: {
      id: 'atm-01', templeId: 'temple-01', enabled: true, cashEnabled: true,
      credentialHash: 'd'.repeat(64), cashStreamId: streamId, activeVisitId: visitId,
    },
    visit: {
      id: visitId, atmId: 'atm-01', templeId: 'temple-01', mode: 'cash', cashSessionId, state: 'confirmed',
      ownerWallet: owner, cashConsentVersion: 'cash-session-v1', cashAcceptedPaise: '10000',
      acceptingAt: now, cashDeadline: now + 120000, cashCloseRequested: true, cashCloseRequestedAt: now + 2500,
      donationId,
    },
    consent: { used: true, visitId, cashSessionId, atmId: 'atm-01', templeId: 'temple-01', wallet: owner },
    command: {
      commandId: `cash-start-${cashSessionId}`, type: 'start_cash', state: 'reported', deviceState: 'ACCEPTING',
      observedAt: now, atmId: 'atm-01', visitId, cashSessionId, templeId: 'temple-01',
    },
    stream: { lastSequence: 4, lastOccurredAt: now + 3000 },
    events: rawEvents.map((event) => ({ id: event.deviceEventId, event, payloadHash: cashEvidenceHash(event), receivedAt: event.occurredAt + 10 })),
    rejectedCount: 0, donation,
    job: {
      donationId, ownerWallet: owner, templeKey, kind: 1,
      day: Math.floor((now + 3100) / 86_400_000).toString(), status: 'minted', txHash,
    },
    total: { wallet: owner, templeId: 'temple-01', points: '10000000' },
    walletDonations: [donation],
  };
}
function mintEvidence(evidence) {
  const { job, donation } = evidence;
  const context = {
    address: stamp, transactionHash: txHash, blockHash, blockNumber: 100n,
    removed: false, transactionIndex: 0,
  };
  const logs = [{
    ...context, logIndex: 0,
    topics: encodeEventTopics({ abi: stampAbi, eventName: 'StampMinted', args: {
      donationId: job.donationId, recipient: owner, tokenId: BigInt(job.donationId),
    } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }], [templeKey, 1, BigInt(job.day)]),
  }, {
    ...context, logIndex: 1,
    topics: encodeEventTopics({ abi: stampAbi, eventName: 'TransferSingle', args: {
      operator: minter, from: `0x${'00'.repeat(20)}`, to: owner,
    } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(job.donationId), 1n]),
  }];
  return {
    donation, job, stamp, minter, chainId: 84532,
    receipt: { status: 'success', transactionHash: txHash, from: minter, to: stamp, blockNumber: 100n, blockHash, logs },
    block: { number: 100n, hash: blockHash },
  };
}
test('pure evidence: balanced cash, exact owner points and canonical Stamp receipt are required together', () => {
  const evidence = fixture();
  const report = verifyCashEvidence(evidence);
  assert.equal(report.status, 'pending');
  assert.equal(report.confirmed, false);
  assert.equal(report.exitCode, 2);
  const result = verifyMintReceiptEvidence(report, mintEvidence(evidence));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.exitCode, 0);
  assert.ok(result.checks.every((item) => item.ok));
  assert.equal(result.storedPaise, '10000');
  assert.equal(result.storedNotes, 1);
});
test('output does not disclose wallets, credential hash, raw notes, signatures or raw transactions', () => {
  const evidence = fixture();
  evidence.job.rawTransaction = 'private-raw-transaction-fixture';
  evidence.consent.signature = 'private-signature-fixture';
  const result = verifyMintReceiptEvidence(verifyCashEvidence(evidence), mintEvidence(evidence));
  const output = JSON.stringify(result);
  for (const secret of [owner, minter, evidence.atm.credentialHash, evidence.job.rawTransaction, evidence.consent.signature, 'fixture-note-1']) {
    assert.ok(!output.toLowerCase().includes(secret.toLowerCase()));
  }
});
test('missing session, unclosed session and closed zero explicitly remain not confirmed', () => {
  assert.equal(verifyCashEvidence({ cashSessionId }).status, 'not_confirmed');
  const pending = fixture();
  pending.events = pending.events.slice(0, 3);
  pending.session.ledger = pending.events.reduce((ledger, row) => applyCashEvent(ledger, row.event), newCashLedger());
  pending.visit.state = 'accepting';
  delete pending.visit.donationId;
  pending.donation = null;
  pending.job = null;
  assert.equal(verifyCashEvidence(pending).status, 'not_confirmed');
  const zero = fixture();
  zero.events = [zero.events[0], zero.events[3]];
  const close = zero.events[1];
  close.id = `${streamId}:2`;
  Object.assign(close.event, { sequence: 2, deviceEventId: close.id });
  Object.assign(close.event.data, { inventory: inventory(), creditedNotes: 0, creditedPaise: '0' });
  close.payloadHash = cashEvidenceHash(close.event);
  zero.session.ledger = zero.events.reduce((ledger, row) => applyCashEvent(ledger, row.event), newCashLedger());
  zero.visit.state = 'closed';
  zero.visit.cashAcceptedPaise = '0';
  delete zero.visit.donationId;
  zero.donation = null;
  zero.job = null;
  const result = verifyCashEvidence(zero);
  assert.equal(result.status, 'not_confirmed');
  assert.equal(result.reason, 'closed_zero_no_donation');
  assert.notEqual(result.exitCode, 0);
});
test('missing receipt or unpersisted mint completion never yields success', () => {
  const evidence = fixture();
  const report = verifyCashEvidence(evidence);
  const mint = mintEvidence(evidence);
  assert.equal(verifyMintReceiptEvidence(report, { ...mint, receipt: null }).status, 'pending');
  mint.job.status = 'submitted';
  mint.donation.mintStatus = 'submitted';
  const result = verifyMintReceiptEvidence(report, mint);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'mint_completion_not_persisted');
  assert.notEqual(result.exitCode, 0);
});
test('consent, ATM, visit, deterministic donation and fee mismatches fail without exposing raw input', () => {
  for (const mutate of [
    (e) => { e.consent.used = false; },
    (e) => { e.consent.wallet = minter; },
    (e) => { e.session.atmId = 'atm-02'; },
    (e) => { e.visit.cashSessionId = streamId; },
    (e) => { e.command.deviceState = 'DISABLED'; },
    (e) => { e.donation.id = txHash; },
    (e) => { e.donation.amount = '999999'; },
    (e) => { e.donation.fee = '1'; },
    (e) => { e.donation.net = '1000000'; },
    (e) => { e.donation.txHash = txHash; },
    (e) => { e.donation.chainId = 84532; },
    (e) => { e.donation.recipient = owner; },
    (e) => { e.job.kind = 0; },
  ]) {
    const evidence = fixture();
    mutate(evidence);
    const result = verifyCashEvidence(evidence);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.exitCode, 1);
  }
});
test('payload changes, sequence gaps, note drift, ambiguous close and rejected evidence prevent confirmation', () => {
  for (const mutate of [
    (e) => { e.events[2].payloadHash = '0'.repeat(64); },
    (e) => { e.events.splice(1, 1); },
    (e) => { e.session.ledger.notes[0].noteKey = 'wrong-note'; },
    (e) => { e.events[3].event.data.disabled = false; e.events[3].payloadHash = cashEvidenceHash(e.events[3].event); },
    (e) => { delete e.events[3].event.data.inventory.counters.stored; },
    (e) => { e.rejectedCount = 1; },
    (e) => { e.atm.cashReconciliationRequired = true; },
    (e) => { e.visit.state = 'needs_reconciliation'; },
    (e) => { e.visit.cashCloseRequestedAt = now + 500; },
    (e) => { e.stream.lastSequence = 2; },
  ]) {
    const evidence = fixture();
    mutate(evidence);
    assert.equal(verifyCashEvidence(evidence).status, 'mismatch');
  }
});
test('points are exactly aggregated for the wallet and temple, not merely at least this donation', () => {
  const evidence = fixture();
  evidence.walletDonations.push({
    ...evidence.donation, id: `0x${'dd'.repeat(32)}`, kind: 0, paymentMethod: 'crypto', amount: '10000',
  });
  evidence.total.points = '10010000';
  assert.equal(verifyCashEvidence(evidence).status, 'pending');
  evidence.total.points = '20000000';
  assert.equal(verifyCashEvidence(evidence).status, 'mismatch');
  evidence.total.points = '10000000';
  assert.equal(verifyCashEvidence(evidence).status, 'mismatch');
});
test('bounded query truncation is unknown, never successful partial verification', () => {
  const evidence = fixture();
  evidence.truncated = true;
  const result = verifyCashEvidence(evidence);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'bounded_query_limit');
  assert.notEqual(result.exitCode, 0);
});
test('resumed sessions require the same durable stream and exact predecessor close evidence', () => {
  const evidence = fixture();
  for (const row of evidence.events) {
    row.event.sequence += 4;
    row.id = `${streamId}:${row.event.sequence}`;
    row.event.deviceEventId = row.id;
    row.payloadHash = cashEvidenceHash(row.event);
  }
  evidence.stream.lastSequence = 8;
  const previous = structuredClone(evidence.events.at(-1));
  previous.id = `${streamId}:4`;
  Object.assign(previous.event, {
    sequence: 4, deviceEventId: previous.id, cashSessionId: '30000000-0000-4000-8000-000000000001',
    visitId: 'b'.repeat(64), occurredAt: now - 1,
  });
  previous.payloadHash = cashEvidenceHash(previous.event);
  evidence.predecessor = previous;
  assert.equal(verifyCashEvidence(evidence).status, 'pending');
  delete evidence.predecessor;
  assert.equal(verifyCashEvidence(evidence).status, 'mismatch');
  evidence.predecessor = previous;
  evidence.atm.cashStreamId = '30000000-0000-4000-8000-000000000001';
  assert.equal(verifyCashEvidence(evidence).status, 'mismatch');
});
test('canonical block, chain, sender, target and tx hash are mandatory', () => {
  for (const mutate of [
    (m) => { m.chainId = 1; },
    (m) => { m.receipt.status = 'reverted'; },
    (m) => { m.receipt.from = owner; },
    (m) => { m.receipt.to = owner; },
    (m) => { m.receipt.transactionHash = blockHash; },
    (m) => { m.block.hash = txHash; },
    (m) => { m.block.number = 99n; },
  ]) {
    const evidence = fixture();
    const mint = mintEvidence(evidence);
    mutate(mint);
    assert.equal(verifyMintReceiptEvidence(verifyCashEvidence(evidence), mint).status, 'mismatch');
  }
});
test('exact Stamp event and ERC1155 transfer count, values and log context are checked', () => {
  for (const mutate of [
    (m) => { m.receipt.logs.pop(); },
    (m) => { m.receipt.logs.push(m.receipt.logs[0]); },
    (m) => { m.receipt.logs[0].topics[2] = `0x${'00'.repeat(12)}${minter.slice(2)}`; },
    (m) => { m.receipt.logs[0].data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }], [templeKey, 0, BigInt(m.job.day)]); },
    (m) => { m.receipt.logs[1].data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(m.job.donationId), 2n]); },
    (m) => { m.receipt.logs[1].removed = true; },
    (m) => { m.receipt.logs[0].blockHash = txHash; },
    (m) => { m.receipt.logs[1].transactionHash = blockHash; },
    (m) => { m.receipt.logs[0].address = owner; },
  ]) {
    const evidence = fixture();
    const mint = mintEvidence(evidence);
    mutate(mint);
    assert.equal(verifyMintReceiptEvidence(verifyCashEvidence(evidence), mint).status, 'mismatch');
  }
});
test('preflight accounts for global pending reservations and both demo limits without enabling cash', () => {
  const atm = fixture().atm;
  delete atm.cashEnabled;
  const empty = assessCashPreflight('atm-01', atm, undefined, now);
  assert.equal(empty.canFitOne100Inr, true);
  assert.deepEqual(empty.registrationChangesRequired, ['cashEnabled']);
  const exact = assessCashPreflight('atm-01', atm, { storedPaise: '80000', pendingPaise: '10000', storedNotes: 8, pendingNotes: 1 }, now);
  assert.equal(exact.canFitOne100Inr, true);
  for (const budget of [
    { storedPaise: '90001', pendingPaise: '0', storedNotes: 1, pendingNotes: 0 },
    { storedPaise: '0', pendingPaise: '0', storedNotes: 9, pendingNotes: 1 },
    { storedPaise: '0', pendingPaise: '-1', storedNotes: 0, pendingNotes: 0 },
    {},
  ]) assert.equal(assessCashPreflight('atm-01', atm, budget, now).canFitOne100Inr, false);
  assert.equal(empty.cashEnabled, false);
  assert.equal(empty.physicalPermissionGrantedByVerifier, false);
});
