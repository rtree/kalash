import { randomBytes } from 'node:crypto';
import {
  decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseEventLogs,
  toHex, TransactionReceiptNotFoundError, TransactionNotFoundError,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { CHAIN_ID, donationTypes, parseAmount, vaultAbi, type Donation } from '../shared.ts';
import { chain, db, deployment, minter } from './config.ts';
import { temples } from './catalog.ts';
import { HttpError, requireValue } from './errors.ts';

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
export async function createDonation(owner: Address, templeId: unknown, input: unknown): Promise<Donation> {
  requireValue(deployment, 503, 'CONTRACTS_NOT_DEPLOYED', 'Donation contracts have not been deployed.');
  const temple = temples.find((item) => item.id === templeId);
  requireValue(temple, 400, 'UNKNOWN_TEMPLE', 'Unknown temple.');
  let amount: bigint;
  try { amount = parseAmount(input); } catch (error) {
    throw new HttpError(400, 'INVALID_AMOUNT', error instanceof Error ? error.message : 'Invalid amount.');
  }
  const id = `0x${randomBytes(32).toString('hex')}` as Hex;
  const templeKey = keccak256(toHex(temple.id));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const startBlock = await chain.getBlockNumber();
  const signature = await minter.signTypedData({
    domain: { name: 'KALASH Donation', version: '1', chainId: CHAIN_ID, verifyingContract: deployment.vault },
    types: donationTypes, primaryType: 'Donation',
    message: { donationId: id, donor: owner, templeId: templeKey, kind: 0, amount, deadline: BigInt(deadline) },
  });
  const record: Donation = {
    id, ownerWallet: owner, templeId: temple.id, templeKey, kind: 0, amount: amount.toString(),
    fee: (amount / 10000n).toString(), net: (amount - amount / 10000n).toString(),
    recipient: temple.recipient, deadline, signature, status: 'intent',
    createdAt: new Date().toISOString(), startBlock: startBlock.toString(),
  };
  await donationReference(id).create(record);
  return record;
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
    const attempt = reference.collection('operations').doc(attemptId);
    const existing = await transaction.get(attempt);
    if (existing.exists) {
      requireValue(existing.get('operation') === operation, 409, 'ATTEMPT_REUSED', 'Attempt ID belongs to another operation.');
      return;
    }
    requireValue(data.deadline > Math.floor(Date.now() / 1000), 409, 'INTENT_EXPIRED', 'Donation intent expired. Verify any unknown submission before starting again.');
    requireValue(data.status === 'intent' && !data.donateAttemptId, 409, 'OPERATION_EXISTS', 'A donation operation is already in progress. Verify it; do not resend.');
    transaction.create(attempt, {
      operation, source: owner, chainId: CHAIN_ID, target: operation === 'donate' ? deployment!.vault : 'USDC',
      amount: data.amount, startBlock: data.startBlock, createdAt: new Date().toISOString(),
    });
    if (operation === 'donate') transaction.update(reference, { donateAttemptId: attemptId, status: 'submitting' });
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
  requireValue('chainId' in transaction && transaction.chainId === CHAIN_ID && transaction.to?.toLowerCase() === deployment.vault.toLowerCase()
    && transaction.from.toLowerCase() === owner.toLowerCase(), 400, 'TX_MISMATCH', 'Transaction chain, sender or target does not match the intent.');
  const expectedInput = encodeFunctionData({
    abi: vaultAbi, functionName: 'donate',
    args: [record.id, record.templeKey, 0, BigInt(record.amount), BigInt(record.deadline), record.signature],
  });
  requireValue(transaction.input.toLowerCase() === expectedInput.toLowerCase(), 400, 'CALL_MISMATCH', 'Transaction calldata does not match the immutable intent.');
  const decoded = decodeFunctionData({ abi: vaultAbi, data: transaction.input });
  requireValue(decoded.functionName === 'donate', 400, 'CALL_MISMATCH', 'Unexpected contract call.');
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  requireValue(block.hash === receipt.blockHash, 409, 'NONCANONICAL', 'Transaction is not in the current canonical block.');
  if (receipt.status !== 'success') {
    await donationReference(id).update({ status: 'failed', txHash: receipt.transactionHash, error: 'Transaction reverted; no donation was confirmed.' });
    return ownedDonation(id, owner);
  }
  const vault = deployment.vault;
  const logs = parseEventLogs({
    abi: vaultAbi, eventName: 'Donated',
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === vault.toLowerCase()), strict: true,
  });
  requireValue(logs.length === 1, 400, 'EVENT_MISMATCH', 'Expected exactly one Donated event.');
  const log = logs[0]!;
  const args = log.args;
  requireValue(args.donationId === record.id && args.donor.toLowerCase() === owner.toLowerCase()
    && args.templeId === record.templeKey && args.kind === 0 && args.amount === BigInt(record.amount)
    && args.fee === BigInt(record.fee) && getAddress(args.recipient) === getAddress(record.recipient)
    && block.timestamp <= BigInt(record.deadline), 400, 'EVENT_MISMATCH', 'Donation event values do not match the registered intent.');
  const reference = donationReference(id);
  const eventReference = db.collection('chainEvents').doc(`${CHAIN_ID}_${receipt.transactionHash}_${log.logIndex}`);
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
      points: (BigInt(total.get('points') ?? '0') + BigInt(record.amount)).toString(),
    });
    tx.create(jobReference, {
      donationId: record.id, ownerWallet: owner, templeKey: record.templeKey, kind: 0,
      day: (block.timestamp / 86400n).toString(), status: 'reserved', createdAt: new Date().toISOString(),
    });
  });
  return ownedDonation(id, owner);
}
