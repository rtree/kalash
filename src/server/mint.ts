import { randomUUID } from 'node:crypto';
import {
  encodeFunctionData, keccak256, parseEventLogs, parseEther,
  TransactionReceiptNotFoundError, type Address, type Hex,
} from 'viem';
import { stampAbi } from '../shared.ts';
import { chain, db, deployment, minter, signer } from './config.ts';
import { donationReference } from './donations.ts';
import { requireValue } from './errors.ts';

const instanceId = randomUUID();
const leaseReference = db.collection('processLeases').doc('minter');
const budgetReference = db.collection('budgets').doc('minter');
const MAX_GAS_WEI = parseEther('0.003');
const MAX_MINTS = 20;
interface MintJob {
  donationId: Hex;
  ownerWallet: Address;
  templeKey: Hex;
  kind: 0;
  day: string;
  status: 'reserved' | 'prepared' | 'submitted' | 'minted' | 'error';
  rawTransaction?: Hex;
  txHash?: Hex;
}
async function lease(): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(leaseReference);
    if (snapshot.exists && snapshot.get('owner') !== instanceId && snapshot.get('expiresAt') > Date.now()) return false;
    tx.set(leaseReference, { owner: instanceId, expiresAt: Date.now() + 60000 });
    return true;
  });
}
async function processJob(job: MintJob) {
  const reference = db.collection('mintJobs').doc(job.donationId);
  if (!job.rawTransaction) {
    const encoded = encodeFunctionData({
      abi: stampAbi, functionName: 'mint',
      args: [job.donationId, job.ownerWallet, job.templeKey, job.kind, BigInt(job.day)],
    });
    const gas = await chain.estimateGas({ account: minter, to: deployment!.stamp, data: encoded });
    const fees = await chain.estimateFeesPerGas();
    const gasLimit = gas * 12n / 10n;
    const gasReserve = gasLimit * fees.maxFeePerGas * 2n + 1000000000000n;
    const nonce = await chain.getTransactionCount({ address: minter.address, blockTag: 'pending' });
    const rawTransaction = await minter.signTransaction({
      chainId: 84532, type: 'eip1559', to: deployment!.stamp, data: encoded,
      nonce, gas: gasLimit, ...fees,
    });
    const txHash = keccak256(rawTransaction);
    await db.runTransaction(async (tx) => {
      const [current, lock, budget] = await Promise.all([
        tx.get(reference), tx.get(leaseReference), tx.get(budgetReference),
      ]);
      requireValue(lock.get('owner') === instanceId && lock.get('expiresAt') > Date.now(),
        409, 'LEASE_LOST', 'Minter lease lost before persistence.');
      requireValue(!current.get('rawTransaction'), 409, 'MINT_PREPARED', 'Mint transaction already prepared.');
      const reserved = BigInt(budget.get('reservedWei') ?? '0');
      const count = Number(budget.get('transactions') ?? 0);
      requireValue(reserved + gasReserve <= MAX_GAS_WEI && count < MAX_MINTS,
        409, 'MINT_BUDGET', 'Minter gas or transaction budget reached. Human authorization required.');
      tx.set(budgetReference, { reservedWei: (reserved + gasReserve).toString(), transactions: count + 1 });
      tx.update(reference, {
        rawTransaction, txHash, nonce, status: 'prepared', reservedGasWei: gasReserve.toString(),
      });
      tx.update(donationReference(job.donationId), { mintStatus: 'prepared', mintTxHash: txHash });
    });
    job = { ...job, rawTransaction, txHash, status: 'prepared' };
  }
  requireValue(job.txHash && job.rawTransaction, 409, 'MINT_INVARIANT', 'Prepared mint is missing its persisted transaction.');
  let receipt;
  try { receipt = await chain.getTransactionReceipt({ hash: job.txHash }); } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }
  if (!receipt) {
    const lock = await leaseReference.get();
    requireValue(lock.get('owner') === instanceId && lock.get('expiresAt') > Date.now(),
      409, 'LEASE_LOST', 'Minter lease expired before broadcast.');
    try {
      await signer.sendRawTransaction({ serializedTransaction: job.rawTransaction });
    } catch (error) {
      // Re-query the persisted hash; a send error never authorizes a new transaction.
      try { receipt = await chain.getTransactionReceipt({ hash: job.txHash }); } catch (lookupError) {
        if (!(lookupError instanceof TransactionReceiptNotFoundError)) throw lookupError;
      }
      if (!receipt) {
        await reference.update({ lastError: 'Broadcast outcome unknown; the same signed transaction is retained.', lastErrorAt: new Date().toISOString() });
        console.error(JSON.stringify({ event: 'mint_broadcast_unknown', donationId: job.donationId, error: error instanceof Error ? error.name : 'UnknownError' }));
        return;
      }
    }
    if (!receipt) {
      await reference.update({ status: 'submitted' });
      await donationReference(job.donationId).update({ mintStatus: 'submitted' });
      return;
    }
  }
  requireValue(receipt.status === 'success', 409, 'MINT_REVERTED', 'Persisted mint transaction reverted; operator reconciliation required.');
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  requireValue(block.hash === receipt.blockHash && receipt.to?.toLowerCase() === deployment!.stamp.toLowerCase()
    && receipt.from.toLowerCase() === minter.address.toLowerCase(), 409, 'MINT_RECEIPT', 'Mint receipt is noncanonical or has an unexpected target/sender.');
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === deployment!.stamp.toLowerCase());
  const events = parseEventLogs({ abi: stampAbi, eventName: 'StampMinted', logs, strict: true });
  const transfers = parseEventLogs({ abi: stampAbi, eventName: 'TransferSingle', logs, strict: true });
  const tokenId = BigInt(job.donationId);
  requireValue(events.length === 1 && transfers.length === 1, 409, 'MINT_EVENT', 'Expected stamp and ERC-1155 mint events.');
  const event = events[0]!.args;
  const transfer = transfers[0]!.args;
  requireValue(event.donationId === job.donationId && event.recipient.toLowerCase() === job.ownerWallet.toLowerCase()
    && event.tokenId === tokenId && event.templeId === job.templeKey && event.kind === job.kind
    && event.day === BigInt(job.day) && transfer.to.toLowerCase() === job.ownerWallet.toLowerCase()
    && transfer.from === '0x0000000000000000000000000000000000000000'
    && transfer.id === tokenId && transfer.value === 1n, 409, 'MINT_EVENT', 'Stamp event does not match the durable reservation.');
  await db.runTransaction(async (tx) => {
    tx.update(reference, { status: 'minted', mintedAt: new Date().toISOString(), lastError: null });
    tx.update(donationReference(job.donationId), { mintStatus: 'minted', mintTxHash: job.txHash, tokenId: tokenId.toString() });
  });
}
let running = false;
export async function mintTick() {
  if (running || !deployment || process.env.MINT_ENABLED !== 'true') return;
  running = true;
  try {
    if (!await lease()) return;
    const jobs = await db.collection('mintJobs').where('status', 'in', ['prepared', 'submitted', 'reserved']).get();
    const ordered = jobs.docs.map((doc) => doc.data() as MintJob)
      .sort((a, b) => Number(a.status === 'reserved') - Number(b.status === 'reserved'));
    if (ordered[0]) await processJob(ordered[0]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'mint_tick_failed', instanceId, code: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message.split('\n')[0] : 'Unexpected mint failure' }));
  } finally { running = false; }
}
