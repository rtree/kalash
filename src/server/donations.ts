import { randomBytes } from 'node:crypto';
import {
  encodeFunctionData, keccak256, parseAbi,
  toHex, TransactionReceiptNotFoundError, TransactionNotFoundError,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import {
  CHAIN_ID, USDC, donationPointUnits, donationTypes, parseAmount, vaultAbi, vaultFeeRecipientAbi, type Donation,
} from '../shared.ts';
import { chain, db, deployment, minter } from './config.ts';
import { temples } from './catalog.ts';
import { HttpError, requireValue } from './errors.ts';
import { validateDonationReceiptEvidence } from './donation-receipt.ts';

const approvalEventAbi = parseAbi([
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);

export function donationReference(id: unknown) {
  requireValue(typeof id === 'string' && /^0x[0-9a-f]{64}$/i.test(id), 400, 'INVALID_ID', 'Invalid donation ID.');
  return db.collection('donations').doc(id.toLowerCase());
}
export async function ownedDonation(id: unknown, owner: Address): Promise<Donation> {
  const record = (await donationReference(id).get()).data() as Donation | undefined;
  requireValue(record, 404, 'NOT_FOUND', 'Donation not found.');
  requireValue(record.ownerWallet.toLowerCase() === owner.toLowerCase(), 403, 'NOT_OWNER', 'This donation belongs to another wallet.');
  return record;
}
async function buildDonationIntent(
  owner: Address, templeId: unknown, input: unknown, kind: 0 | 1, onsiteVisitId?: string,
): Promise<Donation> {
  requireValue(deployment, 503, 'CONTRACTS_NOT_DEPLOYED', 'Donation contracts have not been deployed.');
  const temple = temples.find((item) => item.id === templeId);
  requireValue(temple, 400, 'UNKNOWN_TEMPLE', 'Unknown temple.');
  let amount: bigint;
  try { amount = parseAmount(input); } catch (error) {
    throw new HttpError(400, 'INVALID_AMOUNT', error instanceof Error ? error.message : 'Invalid amount.');
  }
  const now = Math.floor(Date.now() / 1000);
  const cancelledIntents = await db.collection('donations')
    .where('ownerWallet', '==', owner)
    .where('status', '==', 'cancelled')
    .get();
  const stillValid = cancelledIntents.docs
    .map((doc) => doc.data() as Donation)
    .filter((donation) => donation.approvalResolution?.outcome === 'cancelled' && donation.deadline > now)
    .sort((a, b) => a.deadline - b.deadline)[0];
  if (stillValid) {
    throw new HttpError(409, 'SIGNED_INTENT_STILL_VALID',
      `A cancelled approval-only signature remains valid until ${new Date(stillValid.deadline * 1000).toISOString()}. No new intent or MetaMask request was created. Wait until it expires before donating again.`);
  }
  const id = `0x${randomBytes(32).toString('hex')}` as Hex;
  const templeKey = keccak256(toHex(temple.id));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const startBlock = await chain.getBlockNumber();
  const signature = await minter.signTypedData({
    domain: { name: 'KALASH Donation', version: '1', chainId: CHAIN_ID, verifyingContract: deployment.vault },
    types: donationTypes, primaryType: 'Donation',
    message: { donationId: id, donor: owner, templeId: templeKey, kind, amount, deadline: BigInt(deadline) },
  });
  const record: Donation = {
    id, ownerWallet: owner, templeId: temple.id, templeKey, kind, ...(onsiteVisitId ? { onsiteVisitId } : {}), amount: amount.toString(),
    fee: (amount / 10000n).toString(), net: (amount - amount / 10000n).toString(),
    recipient: temple.recipient, deadline, signature, status: 'intent',
    createdAt: new Date().toISOString(), startBlock: startBlock.toString(),
  };
  return record;
}
export async function createDonation(owner: Address, templeId: unknown, input: unknown): Promise<Donation> {
  const record = await buildDonationIntent(owner, templeId, input, 0);
  await donationReference(record.id).create(record);
  return record;
}
export async function createOnsiteDonation(owner: Address, visitId: unknown, input: unknown, requestId: unknown): Promise<Donation> {
  requireValue(typeof visitId === 'string' && /^([a-f0-9]{64})$/.test(visitId),
    400, 'INVALID_VISIT', 'Invalid onsite reception reference.');
  requireValue(typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId),
    400, 'INVALID_REQUEST_ID', 'A stable onsite donation request ID is required.');
  let requestedAmount: string;
  try { requestedAmount = parseAmount(input).toString(); } catch (error) {
    throw new HttpError(400, 'INVALID_AMOUNT', error instanceof Error ? error.message : 'Invalid amount.');
  }
  const visitReference = db.collection('visits').doc(visitId);
  const requestReference = visitReference.collection('donationRequests').doc(requestId);
  const existingRequest = await requestReference.get();
  if (existingRequest.exists) {
    const record = await ownedDonation(existingRequest.get('donationId'), owner);
    requireValue(record.kind === 1 && record.onsiteVisitId === visitId && record.amount === requestedAmount,
      409, 'DONATION_REQUEST_MISMATCH', 'This request ID belongs to another onsite donation.');
    return record;
  }
  const visitSnapshot = await visitReference.get();
  const visit = visitSnapshot.data();
  if (visit?.donationId) {
    const existing = await ownedDonation(visit.donationId, owner);
    requireValue(existing.kind === 1 && existing.onsiteVisitId === visitId && existing.amount === requestedAmount,
      409, 'ONSITE_DONATION_EXISTS', 'This reception already has a different donation. Check it with Central before taking another action.');
    return existing;
  }
  requireValue(visit?.mode === 'crypto' && visit.state === 'linked'
    && typeof visit.templeId === 'string' && typeof visit.ownerWallet === 'string'
    && visit.ownerWallet.toLowerCase() === owner.toLowerCase(),
  403, 'ONSITE_VISIT_NOT_CLAIMED', 'Verify your wallet and explicitly join this onsite Crypto reception first.');
  const record = await buildDonationIntent(owner, visit.templeId, input, 1, visitId);
  const donationRef = donationReference(record.id);
  let selectedId = record.id;
  await db.runTransaction(async (tx) => {
    const [currentSnapshot, requestSnapshot] = await Promise.all([
      tx.get(visitReference), tx.get(requestReference),
    ]);
    const current = currentSnapshot.data();
    if (requestSnapshot.exists) {
      selectedId = requestSnapshot.get('donationId');
      return;
    }
    if (current?.donationId) {
      selectedId = current.donationId;
      return;
    }
    requireValue(current?.state === 'linked' && current.mode === 'crypto'
      && current.templeId === visit.templeId && current.ownerWallet?.toLowerCase() === owner.toLowerCase(),
    409, 'ONSITE_VISIT_CHANGED', 'The onsite reception changed. Restore it before donating.');
    tx.create(donationRef, record);
    tx.create(requestReference, { donationId: record.id, amount: record.amount, createdAt: new Date().toISOString() });
    tx.update(visitReference, { state: 'donation_pending', donationId: record.id, donationStartedAt: Date.now() });
  });
  const selected = await ownedDonation(selectedId, owner);
  requireValue(selected.kind === 1 && selected.onsiteVisitId === visitId && selected.amount === requestedAmount,
    409, 'ONSITE_DONATION_MISMATCH', 'The reception already has a different donation. Do not send another.');
  return selected;
}
export async function recordOperation(id: unknown, owner: Address, operation: unknown, attemptId: unknown) {
  requireValue(operation === 'approve' || operation === 'donate', 400, 'INVALID_OPERATION', 'Unknown wallet operation.');
  requireValue(typeof attemptId === 'string' && /^[a-z0-9-]{36}$/i.test(attemptId),
    400, 'INVALID_ATTEMPT', 'A stable operation attempt ID is required.');
  const reference = donationReference(id);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() as Donation | undefined;
    requireValue(data?.ownerWallet.toLowerCase() === owner.toLowerCase(), 403, 'NOT_OWNER', 'Donation permission denied.');
    requireValue(data.status !== 'cancelled' && data.status !== 'expired',
      409, 'INTENT_ABANDONED', 'This donation intent is no longer active.');
    const attempt = reference.collection('operations').doc(attemptId);
    const existing = await transaction.get(attempt);
    if (existing.exists) {
      requireValue(existing.get('operation') === operation, 409, 'ATTEMPT_REUSED', 'Attempt ID belongs to another operation.');
      return;
    }
    requireValue(data.deadline > Math.floor(Date.now() / 1000), 409, 'INTENT_EXPIRED', 'Donation intent expired. Verify any unknown submission before starting again.');
    requireValue(data.status === 'intent' && !data.donateAttemptId, 409, 'OPERATION_EXISTS', 'A donation operation is already in progress. Verify it; do not resend.');
    transaction.create(attempt, {
      operation, source: owner, chainId: CHAIN_ID, target: operation === 'donate' ? deployment!.vault : USDC,
      amount: data.amount, startBlock: data.startBlock, createdAt: new Date().toISOString(),
    });
    if (operation === 'donate') transaction.update(reference, { donateAttemptId: attemptId, status: 'submitting' });
  });
  return ownedDonation(id, owner);
}
export async function resolveApprovalOnlyIntent(
  id: unknown,
  owner: Address,
  attemptId: unknown,
  confirmNoWalletRequest: unknown,
): Promise<Donation> {
  requireValue(deployment, 503, 'CONTRACTS_NOT_DEPLOYED', 'Contracts unavailable.');
  requireValue(typeof attemptId === 'string' && /^[a-z0-9-]{36}$/i.test(attemptId),
    400, 'INVALID_ATTEMPT', 'A stable approval attempt ID is required.');
  requireValue(confirmNoWalletRequest === true, 400, 'WALLET_STATE_CONFIRMATION_REQUIRED',
    'Confirm that no wallet request is still open before resolving this approval-only attempt.');
  const reference = donationReference(id);
  const record = await ownedDonation(id, owner);
  if ((record.status === 'cancelled' || record.status === 'expired')
    && record.approvalResolution?.attemptId === attemptId) return record;
  requireValue(record.status === 'intent'
    && !record.donateAttemptId && !record.txHash,
  409, 'NOT_APPROVAL_ONLY', 'Only an active intent with no donation submission can be resolved.');

  const operations = await reference.collection('operations').get();
  const attempt = operations.docs.find((operation) => operation.id === attemptId);
  requireValue(operations.size > 0 && attempt?.get('operation') === 'approve'
    && attempt.get('source')?.toLowerCase() === owner.toLowerCase()
    && attempt.get('target')?.toLowerCase() === USDC.toLowerCase()
    && attempt.get('amount') === record.amount
    && operations.docs.every((operation) => operation.get('operation') === 'approve'),
  409, 'NOT_APPROVAL_ONLY', 'This intent has a non-approval operation or no registered approval to resolve.');

  const start = BigInt(record.startBlock);
  const latest = await chain.getBlockNumber();
  requireValue(latest >= start,
    409, 'RECONCILIATION_REQUIRED', 'This intent is outside the safe on-chain check window; operator review is required.');
  const deadline = BigInt(record.deadline);
  const latestBlock = await chain.getBlock({ blockNumber: latest });
  const chainExpired = latestBlock.timestamp > deadline;
  let throughBlock = latest;
  if (chainExpired) {
    let low = start;
    let high = latest;
    const startBlock = await chain.getBlock({ blockNumber: start });
    if (startBlock.timestamp > deadline) {
      throughBlock = start - 1n;
    } else {
      while (low < high) {
      const middle = (low + high + 1n) / 2n;
      const block = await chain.getBlock({ blockNumber: middle });
      if (block.timestamp <= deadline) low = middle;
      else high = middle - 1n;
      }
      throughBlock = low;
    }
  }
  const blockCount = throughBlock >= start ? throughBlock - start + 1n : 0n;
  requireValue(blockCount <= 20000n,
    409, 'RECONCILIATION_REQUIRED', 'This intent is outside the safe on-chain check window; operator review is required.');
  let approvalEvents = 0;
  let donatedEvents = 0;
  for (let from = start; from <= throughBlock; from += 200n) {
    const to = from + 199n < throughBlock ? from + 199n : throughBlock;
    const [approvals, donations] = await Promise.all([
      chain.getLogs({
        address: USDC, event: approvalEventAbi[0], args: { owner, spender: deployment.vault },
        fromBlock: from, toBlock: to, strict: true,
      }),
      chain.getLogs({
        address: deployment.vault, event: vaultAbi[1], args: { donationId: record.id },
        fromBlock: from, toBlock: to, strict: true,
      }),
    ]);
    approvalEvents += approvals.length;
    donatedEvents += donations.length;
  }
  requireValue(approvalEvents === 0, 409, 'APPROVAL_EVENT_FOUND',
    'A matching Vault allowance event exists. Keep this operation and review the wallet allowance.');
  requireValue(donatedEvents === 0, 409, 'DONATION_EVENT_FOUND',
    'A matching donation event exists. Keep this operation and ask Central to reconcile it.');
  const allowance = await chain.readContract({
    address: USDC,
    abi: parseAbi(['function allowance(address owner,address spender) view returns (uint256)']),
    functionName: 'allowance',
    args: [owner, deployment.vault],
  });
  requireValue(allowance === 0n, 409, 'ALLOWANCE_ACTIVE',
    'USDC allowance to the donation vault is still active. Do not clear this operation; review the wallet allowance first.');

  const resolvedAt = new Date().toISOString();
  const outcome = chainExpired ? 'expired' : 'cancelled';
  const error = chainExpired
    ? 'Expired approval-only operation checked on Base Sepolia; no approval event, donation event or allowance was found.'
    : 'Approval-only flow abandoned before deadline; no approval event, donation event or allowance was found. The signed intent is not revoked on-chain and remains valid until its deadline.';
  await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(reference);
    const current = currentSnapshot.data() as Donation | undefined;
    requireValue(current?.ownerWallet.toLowerCase() === owner.toLowerCase()
      && current.status === 'intent' && current.deadline === record.deadline
      && current.startBlock === record.startBlock
      && !current.donateAttemptId && !current.txHash,
    409, 'OPERATION_CHANGED', 'The donation state changed during reconciliation; reload it before continuing.');
    transaction.update(reference, {
      status: outcome,
      ...(outcome === 'expired' ? { expiredAt: resolvedAt } : { cancelledAt: resolvedAt }),
      error,
      approvalResolution: {
        attemptId,
        resolvedAt,
        fromBlock: start.toString(),
        throughBlock: throughBlock.toString(),
        outcome,
        signatureValidUntil: record.deadline,
        onchainRevoked: false,
        confirmedNoWalletRequest: true,
        approvalEvents: 0,
        allowanceUnits: '0',
        donatedEvents: 0,
      },
    });
  });
  return ownedDonation(id, owner);
}
async function findReceipt(record: Donation, hint?: Hex): Promise<TransactionReceipt | null> {
  let hash = hint ?? record.txHash;
  if (!hash) {
    const latest = await chain.getBlockNumber();
    const start = BigInt(record.startBlock);
    requireValue(latest - start < 20000n, 409, 'RECONCILIATION_REQUIRED', 'Historical verification requires operator reconciliation; never resend an unknown payment.');
    const found = [];
    for (let from = start; from <= latest; from += 2000n) {
      const end = from + 1999n < latest ? from + 1999n : latest;
      const logs = await chain.getLogs({
        address: deployment!.vault, event: vaultAbi[1], args: { donationId: record.id },
        fromBlock: from, toBlock: end, strict: true,
      });
      found.push(...logs);
    }
    requireValue(found.length <= 1, 409, 'CHAIN_INVARIANT', 'More than one donation event found; reconciliation required.');
    hash = found[0]?.transactionHash ?? undefined;
  }
  if (!hash) return null;
  try { return await chain.getTransactionReceipt({ hash }); } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return null;
    throw error;
  }
}
export async function verifyDonation(id: unknown, owner: Address, hint: unknown): Promise<Donation> {
  requireValue(deployment, 503, 'CONTRACTS_NOT_DEPLOYED', 'Contracts unavailable.');
  requireValue(hint === undefined || (typeof hint === 'string' && /^0x[0-9a-f]{64}$/i.test(hint)),
    400, 'INVALID_HASH', 'Invalid transaction hash.');
  const record = await ownedDonation(id, owner);
  if (record.status === 'confirmed' || record.status === 'failed') return record;
  requireValue(record.donateAttemptId, 409, 'NO_OPERATION', 'No wallet donation operation has been registered.');
  const receipt = await findReceipt(record, hint as Hex | undefined);
  if (!receipt) {
    await donationReference(id).update({
      status: hint ? 'submitted' : 'unknown',
      ...(hint ? { txHash: hint } : {}),
      error: 'Transaction outcome is not yet known. Verify again; do not send a second donation.',
    });
    return ownedDonation(id, owner);
  }
  const transaction = await chain.getTransaction({ hash: receipt.transactionHash });
  requireValue('chainId' in transaction && transaction.chainId === CHAIN_ID,
    400, 'TX_MISMATCH', 'Transaction chain does not match the intent.');
  const directDonation = transaction.to?.toLowerCase() === deployment.vault.toLowerCase()
    && transaction.from.toLowerCase() === owner.toLowerCase();
  if (directDonation) {
    const expectedInput = encodeFunctionData({
      abi: vaultAbi, functionName: 'donate',
      args: [record.id, record.templeKey, record.kind, BigInt(record.amount), BigInt(record.deadline), record.signature],
    });
    requireValue(transaction.input.toLowerCase() === expectedInput.toLowerCase(),
      400, 'CALL_MISMATCH', 'Transaction calldata does not match the immutable intent.');
  }
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  requireValue(block.hash === receipt.blockHash, 409, 'NONCANONICAL', 'Transaction is not in the current canonical block.');
  if (receipt.status !== 'success') {
    await donationReference(id).update({ status: 'failed', txHash: receipt.transactionHash, error: 'Transaction reverted; no donation was confirmed.' });
    return ownedDonation(id, owner);
  }
  const feeRecipient = await chain.readContract({
    address: deployment.vault, abi: vaultFeeRecipientAbi, functionName: 'feeRecipient',
  });
  const logIndex = validateDonationReceiptEvidence(
    receipt.logs, record, owner, deployment.vault, feeRecipient, block.timestamp,
  );
  const reference = donationReference(id);
  const eventReference = db.collection('chainEvents').doc(`${CHAIN_ID}_${receipt.transactionHash}_${logIndex}`);
  const totalReference = db.collection('walletTempleTotals').doc(`${owner.toLowerCase()}_${record.templeId}`);
  const jobReference = db.collection('mintJobs').doc(record.id);
  const confirmedAt = new Date(Number(block.timestamp) * 1000).toISOString();
  await db.runTransaction(async (tx) => {
    const [current, event, total, job] = await Promise.all([
      tx.get(reference), tx.get(eventReference), tx.get(totalReference), tx.get(jobReference),
    ]);
    if (current.get('status') === 'confirmed') {
      requireValue(current.get('txHash') === receipt.transactionHash, 409, 'DUPLICATE_CONFLICT', 'Donation already confirmed by another transaction.');
      return;
    }
    requireValue(!event.exists && !job.exists, 409, 'DUPLICATE_CONFLICT', 'Chain event or mint reservation already consumed.');
    tx.create(eventReference, { donationId: record.id, blockHash: receipt.blockHash });
    tx.update(reference, {
      status: 'confirmed', mintStatus: 'reserved', txHash: receipt.transactionHash,
      confirmedAt, error: null,
    });
    tx.set(totalReference, {
      wallet: owner.toLowerCase(), templeId: record.templeId,
      points: (BigInt(total.get('points') ?? '0') + donationPointUnits(record.amount, record.kind)).toString(),
    });
    tx.create(jobReference, {
      donationId: record.id, ownerWallet: owner, templeKey: record.templeKey, kind: record.kind,
      day: (block.timestamp / 86400n).toString(), status: 'reserved', createdAt: new Date().toISOString(),
    });
  });
  return ownedDonation(id, owner);
}
