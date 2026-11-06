import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  getAddress, keccak256, toHex, TransactionReceiptNotFoundError, verifyMessage,
  type Address, type Hex,
} from 'viem';
import { CHAIN_ID } from '../shared.ts';
import { cashMachineStatus } from '../atm.ts';
import {
  PAYOUT_UUID, cashFeeAbi, cashFeeTypes, exactCashFee, payoutTotal, sameInventory, validatePayoutInventory, validatePayoutCompletion, validatePayoutPartial,
  type CashFeeInvoice, type PayoutCommand, type PayoutInventoryReport, type PayoutState, type PayoutPartialEndState,
  type PayoutReconciliationAuthorization,
} from '../payout.ts';
import { cashTotals, validateCashInventory, type CashInventory, type CashLedger } from '../cash.ts';
import { atmReference, credentialHash, screenCredential, validAtm, validScreen, validateControllerCredential, type AtmRecord } from './atm.ts';
import { chain, db, deployment, minter, origin } from './config.ts';
import { HttpError, requireValue } from './errors.ts';
import { validateCashFeeReceipt } from './cash-fee-receipt.ts';
import { HumanWindowMs } from '../timing.ts';

const adminConfig: { chainId: number; templeWalletAdmins: Record<string, string> } =
  JSON.parse(readFileSync('config/temple-admins.public.json', 'utf8'));
const publicWallets: { wallets: Record<string, string> } = JSON.parse(readFileSync('config/wallets.public.json', 'utf8'));
const HASH = /^0x[0-9a-f]{64}$/i;
const MAX_DONATIONS = 200;
interface Account { activeInvoiceId?: Hex; dispensedPaise?: string }
interface CashSource { id: Hex; cashSessionId: string; cashAmountPaise: string }
interface PayoutRecord {
  command: PayoutCommand; state: PayoutState; approver: Address;
  invoiceIds: Hex[]; reportHash?: string; observedAt?: number;
  evidence?: unknown; endState?: PayoutPartialEndState; reconciled?: boolean; reason?: string;
  reconciliation?: PayoutReconciliationAuthorization;
}
function exactFields(body: Record<string, unknown>, allowed: string[], required = allowed) {
  requireValue(Object.keys(body).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(body, key)),
    400, 'INVALID_PAYOUT_FIELDS', 'Missing or unknown payout fields.');
}
function admin(templeId: string, wallet: Address) {
  requireValue(adminConfig.chainId === CHAIN_ID && adminConfig.templeWalletAdmins[templeId]
    && getAddress(adminConfig.templeWalletAdmins[templeId]) === getAddress(wallet),
  403, 'TEMPLE_ADMIN_REQUIRED', 'Only the explicitly registered temple administrator may settle or approve payouts.');
}
function readyIdle(atm: AtmRecord) {
  requireValue(!atm.activeVisitId && !atm.activePayoutId && !atm.cashReconciliationRequired,
    409, 'ATM_BUSY_OR_LOCKED', 'Finish reception or reconcile the existing operation before payout.');
  requireValue(cashMachineStatus(atm.controllerHealth ?? null, Date.now()) === 'ready',
    409, 'CONTROLLER_NOT_READY', 'Fresh Controller readiness is required.');
}
function reportedInventory(atm: AtmRecord) {
  const report = inventoryInput(atm.payoutInventory);
  requireValue(report.deviceId === atm.controllerHealth?.deviceId,
    409, 'PAYOUT_DEVICE_MISMATCH', 'Inventory must belong to the registered live device.');
  return report;
}
function inventoryInput(input: unknown) {
  try { return validatePayoutInventory(input); }
  catch { throw new HttpError(409, 'PAYOUT_INVENTORY_UNVERIFIED', 'Fresh DISABLED, empty escrow and complete inventory evidence is required.'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function sources(templeId: string): Promise<CashSource[]> {
  const rows = await db.collection('donations').where('templeId', '==', templeId).limit(MAX_DONATIONS + 1).get();
  requireValue(rows.size <= MAX_DONATIONS, 409, 'SETTLEMENT_QUERY_LIMIT', 'Cash settlement requires a bounded operator reconciliation.');
  return rows.docs.flatMap((row) => {
    const data = row.data();
    if (data.paymentMethod !== 'cash' || data.status !== 'confirmed') return [];
    requireValue(HASH.test(row.id) && typeof data.cashSessionId === 'string'
      && PAYOUT_UUID.test(data.cashSessionId) && typeof data.cashAmountPaise === 'string'
      && /^[1-9]\d{0,15}$/.test(data.cashAmountPaise), 409, 'INVALID_CASH_SOURCE', 'Malformed cash donation cannot be settled.');
    return [{ id: row.id as Hex, cashSessionId: data.cashSessionId, cashAmountPaise: data.cashAmountPaise }];
  });
}
export async function getTemplePayout(atmId: string, wallet: Address) {
  const atm = validAtm((await atmReference(atmId).get()).data() as AtmRecord | undefined);
  admin(atm.templeId, wallet);
  const account = (await db.collection('cashPayoutAccounts').doc(atmId).get()).data() as Account | undefined;
  const invoice = account?.activeInvoiceId
    ? (await db.collection('cashFeeInvoices').doc(account.activeInvoiceId).get()).data() as CashFeeInvoice | undefined : null;
  const payoutReference = atm.activePayoutId ?? atm.lastPayoutId;
  const payout = payoutReference ? (await db.collection('cashPayouts').doc(payoutReference).get()).data() : null;
  return { atmId, templeId: atm.templeId, cashEnabled: atm.cashEnabled === true,
    activeReception: Boolean(atm.activeVisitId), reconciliationRequired: atm.cashReconciliationRequired === true,
    controllerReady: cashMachineStatus(atm.controllerHealth ?? null, Date.now()) === 'ready',
    inventory: atm.payoutInventory ?? null, invoice: invoice ?? null, payout,
    cashFeeVaultAvailable: Boolean(deployment?.cashFeeVault),
    feeRatePercent: 3, feePaymentWallet: wallet, donationRecipientUnchanged: true };
}
export async function reportPayoutInventory(atmId: string, authorization: string | undefined, body: Record<string, unknown>) {
  await validateControllerCredential(atmId, authorization);
  const report = inventoryInput(body);
  await db.runTransaction(async (tx) => {
    const ref = atmReference(atmId);
    const atm = validAtm((await tx.get(ref)).data() as AtmRecord | undefined);
    requireValue(!atm.activeVisitId && !atm.activePayoutId && !atm.cashReconciliationRequired
      && report.deviceId === atm.controllerHealth?.deviceId, 409, 'PAYOUT_INVENTORY_NOT_IDLE', 'Only the single idle Controller may report payout inventory.');
    const previous = atm.payoutInventory;
    requireValue(!previous || report.rawSequence > previous.rawSequence
      || (report.rawSequence === previous.rawSequence && report.observedAt >= previous.observedAt
        && report.deviceId === previous.deviceId && sameInventory(report.inventory, previous.inventory)),
    409, 'STALE_PAYOUT_INVENTORY', 'A fresh unchanged readback or newer durable observation is required.');
    tx.update(ref, { payoutInventory: report });
  });
  return { accepted: true };
}
export async function createCashFeeInvoice(atmId: string, wallet: Address, body: Record<string, unknown>) {
  exactFields(body, ['requestId']);
  requireValue(typeof body.requestId === 'string' && PAYOUT_UUID.test(body.requestId), 400, 'INVALID_REQUEST_ID', 'A stable invoice request UUID is required.');
  requireValue(deployment?.cashFeeVault, 503, 'CASH_FEE_VAULT_UNDEPLOYED', 'CashFeeVault must be deployed and verified before fee payment.');
  const atmRef = atmReference(atmId);
  const initial = validAtm((await atmRef.get()).data() as AtmRecord | undefined);
  admin(initial.templeId, wallet);
  const candidates = await sources(initial.templeId);
  const invoiceId = keccak256(toHex(`cash-fee-v1:${atmId}:${body.requestId}`));
  const existing = (await db.collection('cashFeeInvoices').doc(invoiceId).get()).data() as CashFeeInvoice | undefined;
  if (existing) {
    requireValue(existing.payer === wallet && existing.atmId === atmId, 403, 'INVOICE_OWNER_MISMATCH', 'Invoice belongs to another administrator.');
    return existing;
  }
  const unpaid: CashSource[] = [];
  for (const source of candidates) {
    const [session, coverage] = await Promise.all([
      db.collection('cashSessions').doc(source.cashSessionId).get(), db.collection('cashFeeCoverage').doc(source.id).get(),
    ]);
    if (session.get('atmId') !== atmId) continue;
    const ledger = session.get('ledger') as CashLedger | undefined;
    requireValue(ledger?.closed && ledger.reconciliationReasons.length === 0
      && cashTotals(ledger).creditedPaise.toString() === source.cashAmountPaise,
    409, 'UNRECONCILED_CASH_SOURCE', 'Only reconciled credited cash can be invoiced.');
    if (!coverage.exists) unpaid.push(source);
  }
  const cashPaise = unpaid.reduce((sum, row) => sum + BigInt(row.cashAmountPaise), 0n);
  requireValue(cashPaise > 0n, 409, 'NO_UNSETTLED_CASH', 'No new unsettled cash; do not pay the fee again.');
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const templeKey = keccak256(toHex(initial.templeId));
  const amount = exactCashFee(cashPaise);
  const signature = await minter.signTypedData({
    domain: { name: 'KALASH Cash Fee', version: '1', chainId: CHAIN_ID, verifyingContract: deployment.cashFeeVault },
    primaryType: 'CashFee', types: cashFeeTypes,
    message: { invoiceId, payer: wallet, templeId: templeKey, amount, deadline: BigInt(deadline) },
  });
  const invoice: CashFeeInvoice = {
    invoiceId, atmId, templeId: initial.templeId, templeKey, payer: wallet, amount: amount.toString(),
    cashPaise: cashPaise.toString(), donationIds: unpaid.map((row) => row.id), deadline,
    status: 'awaiting_payment', vault: deployment.cashFeeVault,
    recipient: getAddress(publicWallets.wallets['fee-recipient']!), signature,
    startBlock: (await chain.getBlockNumber()).toString(),
  };
  return db.runTransaction(async (tx) => {
    const accountRef = db.collection('cashPayoutAccounts').doc(atmId);
    const invoiceRef = db.collection('cashFeeInvoices').doc(invoiceId);
    const [atmSnap, accountSnap, invoiceSnap, ...coverage] = await Promise.all([
      tx.get(atmRef), tx.get(accountRef), tx.get(invoiceRef),
      ...unpaid.map((row) => tx.get(db.collection('cashFeeCoverage').doc(row.id))),
    ]);
    const atm = validAtm(atmSnap.data() as AtmRecord | undefined);
    admin(atm.templeId, wallet);
    readyIdle(atm);
    if (invoiceSnap.exists) return invoiceSnap.data() as CashFeeInvoice;
    const account = accountSnap.data() as Account | undefined;
    const currentInvoice = account?.activeInvoiceId
      ? (await tx.get(db.collection('cashFeeInvoices').doc(account.activeInvoiceId))).data() as CashFeeInvoice | undefined : null;
    requireValue(!currentInvoice || currentInvoice.status === 'paid', 409, 'INVOICE_ALREADY_PENDING', 'Restore the same pending invoice; never submit another payment.');
    requireValue(coverage.every((row) => !row.exists), 409, 'CASH_ALREADY_SETTLED', 'Cash coverage changed; do not submit this fee.');
    tx.create(invoiceRef, invoice);
    tx.set(accountRef, { ...account, activeInvoiceId: invoiceId, dispensedPaise: account?.dispensedPaise ?? '0' });
    return invoice;
  });
}
export async function verifyCashFee(atmId: string, wallet: Address, invoiceId: string, body: Record<string, unknown>) {
  exactFields(body, ['txHash'], []);
  requireValue(HASH.test(invoiceId) && (body.txHash === undefined || (typeof body.txHash === 'string' && HASH.test(body.txHash))),
    400, 'INVALID_FEE_REFERENCE', 'Valid invoice and transaction references are required.');
  const ref = db.collection('cashFeeInvoices').doc(invoiceId);
  const initial = (await ref.get()).data() as CashFeeInvoice | undefined;
  requireValue(initial && initial.atmId === atmId, 404, 'INVOICE_NOT_FOUND', 'Fee invoice not found.');
  admin(initial.templeId, wallet);
  requireValue(getAddress(initial.payer) === getAddress(wallet), 403, 'INVOICE_OWNER_MISMATCH', 'The invoice payer must own the wallet session.');
  if (initial.status === 'paid') return initial;
  let hash = (body.txHash ?? initial.txHash) as Hex | undefined;
  if (!hash) {
    const latest = await chain.getBlockNumber();
    requireValue(latest - BigInt(initial.startBlock) <= 10_000n,
      409, 'FEE_SCAN_LIMIT', 'Use the existing wallet transaction hash; do not repay this invoice.');
    const logs = await chain.getContractEvents({ address: initial.vault, abi: cashFeeAbi, eventName: 'FeePaid',
      args: { invoiceId: initial.invoiceId }, fromBlock: BigInt(initial.startBlock), toBlock: latest, strict: true });
    requireValue(logs.length <= 1, 409, 'FEE_EVENT_CONFLICT', 'Conflicting fee evidence requires operator reconciliation.');
    hash = logs[0]?.transactionHash ?? undefined;
  }
  if (!hash) {
    await ref.update({ status: 'unknown' });
    return { ...initial, status: 'unknown' as const, reason: 'Restore the same invoice. A missing hash is not permission to pay again.' };
  }
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as CashFeeInvoice | undefined;
    requireValue(current && (!current.txHash || current.txHash === hash), 409, 'FEE_HASH_CONFLICT', 'Do not replace the existing payment transaction.');
    if (current.status !== 'paid') tx.update(ref, { status: 'submitted', txHash: hash });
  });
  let receipt;
  try { receipt = await chain.getTransactionReceipt({ hash }); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    return { ...initial, status: 'submitted' as const, txHash: hash, reason: 'Waiting for the existing fee receipt; do not resubmit.' };
  }
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  requireValue(receipt.status === 'success' && receipt.to && getAddress(receipt.to) === getAddress(initial.vault)
    && getAddress(receipt.from) === getAddress(initial.payer) && block.hash === receipt.blockHash
    && receipt.blockNumber >= BigInt(initial.startBlock) && await chain.getChainId() === CHAIN_ID,
  400, 'FEE_RECEIPT_MISMATCH', 'Canonical successful fee receipt, expected chain and payer are required.');
  requireValue(receipt.logs.every((log) => log.transactionHash === hash && log.blockHash === receipt.blockHash
    && log.blockNumber === receipt.blockNumber && !log.removed), 400, 'FEE_LOG_CONTEXT_MISMATCH', 'Fee logs must belong to the canonical receipt.');
  const logIndex = validateCashFeeReceipt(receipt.logs, initial, block.timestamp);
  return db.runTransaction(async (tx) => {
    const eventRef = db.collection('cashFeeChainEvents').doc(`${CHAIN_ID}_${hash}_${logIndex}`);
    const [snapshot, event, ...coverage] = await Promise.all([
      tx.get(ref), tx.get(eventRef), ...initial.donationIds.map((id) => tx.get(db.collection('cashFeeCoverage').doc(id))),
    ]);
    const current = snapshot.data() as CashFeeInvoice | undefined;
    requireValue(current && current.txHash === hash, 409, 'FEE_HASH_CONFLICT', 'Invoice changed while verifying receipt.');
    if (current.status === 'paid') return current;
    requireValue(!event.exists && coverage.every((row) => !row.exists), 409, 'FEE_ALREADY_USED', 'Fee payment cannot cover another invoice.');
    const paid = { ...current, status: 'paid' as const, paidBlock: receipt.blockNumber.toString() };
    tx.update(ref, paid);
    tx.create(eventRef, { invoiceId, blockHash: receipt.blockHash });
    initial.donationIds.forEach((id) => tx.create(db.collection('cashFeeCoverage').doc(id), { invoiceId, atmId, txHash: hash }));
    return paid;
  });
}
export async function recordCashFeeSubmission(atmId: string, wallet: Address, invoiceId: string) {
    requireValue(HASH.test(invoiceId), 400, 'INVALID_FEE_REFERENCE', 'A valid invoice is required.');
    const ref = db.collection('cashFeeInvoices').doc(invoiceId);
    return db.runTransaction(async (tx) => {
      const invoice = (await tx.get(ref)).data() as CashFeeInvoice | undefined;
      requireValue(invoice && invoice.atmId === atmId, 404, 'INVOICE_NOT_FOUND', 'Fee invoice not found.');
      admin(invoice.templeId, wallet);
      requireValue(getAddress(invoice.payer) === getAddress(wallet) && invoice.status === 'awaiting_payment'
        && invoice.deadline * 1000 > Date.now(), 409, 'FEE_SUBMISSION_UNAVAILABLE', 'Restore the existing fee operation; do not send a new payment.');
      tx.update(ref, { status: 'unknown', submissionRecordedAt: Date.now() });
      return { recorded: true, invoiceId };
    });
  }
  interface Approval {
    approvalId: string; atmId: string; templeId: string; payoutId: string; expiresAt: number;
    amountPaise: string; baseline: CashInventory; inventoryReportHash: string;
    invoiceIds: Hex[]; message: string; used: boolean;
  }
  export async function getPayoutApproval(approvalId: string) {
    requireValue(PAYOUT_UUID.test(approvalId), 400, 'INVALID_APPROVAL_ID', 'A valid payout approval reference is required.');
    const approval = (await db.collection('cashPayoutApprovals').doc(approvalId).get()).data() as Approval | undefined;
    requireValue(approval && !approval.used && approval.expiresAt > Date.now(),
      409, 'PAYOUT_APPROVAL_EXPIRED', 'Payout approval expired or already used; restore the existing payout instead.');
    return { approvalId, atmId: approval.atmId, templeId: approval.templeId, amountPaise: approval.amountPaise,
      expiresAt: approval.expiresAt, message: approval.message };
  }
  export async function createPayoutApproval(atmId: string, body: Record<string, unknown>, wallet?: Address, cookie?: string) {
    exactFields(body, ['requestId']);
    requireValue(typeof body.requestId === 'string' && PAYOUT_UUID.test(body.requestId), 400, 'INVALID_REQUEST_ID', 'A stable payout request UUID is required.');
    const atmRef = atmReference(atmId);
    const initial = validAtm((await atmRef.get()).data() as AtmRecord | undefined);
    if (wallet) admin(initial.templeId, wallet);
    else validScreen(initial, screenCredential(cookie));
    readyIdle(initial);
    const candidates = await sources(initial.templeId);
    const ref = db.collection('cashPayoutApprovals').doc(body.requestId);
    return db.runTransaction(async (tx) => {
      const [atmSnap, requestSnap, accountSnap] = await Promise.all([
        tx.get(atmRef), tx.get(ref), tx.get(db.collection('cashPayoutAccounts').doc(atmId)),
      ]);
      const atm = validAtm(atmSnap.data() as AtmRecord | undefined);
      if (wallet) admin(atm.templeId, wallet);
      else validScreen(atm, screenCredential(cookie));
      readyIdle(atm);
      const report = reportedInventory(atm);
      if (requestSnap.exists) {
        const previous = requestSnap.data() as Approval;
        requireValue(previous.atmId === atmId && !previous.used && previous.expiresAt > Date.now(),
          409, 'PAYOUT_REQUEST_CLOSED', 'Restore the existing payout; do not create another command.');
        return { approvalId: previous.approvalId, url: `${origin}/temple-admin/${atmId}?approval=${previous.approvalId}` };
      }
      const account = accountSnap.data() as Account | undefined;
      let creditedPaise = 0n;
      const invoiceIds = new Set<Hex>();
      for (const source of candidates) {
        const session = (await tx.get(db.collection('cashSessions').doc(source.cashSessionId))).data();
        if (session?.atmId !== atmId) continue;
        const ledger = session.ledger as CashLedger;
        requireValue(ledger.closed && ledger.reconciliationReasons.length === 0
          && cashTotals(ledger).creditedPaise.toString() === source.cashAmountPaise,
        409, 'UNRECONCILED_CASH_SOURCE', 'Unreconciled cash cannot be paid out.');
        const coverage = (await tx.get(db.collection('cashFeeCoverage').doc(source.id))).data();
        requireValue(coverage?.atmId === atmId && typeof coverage.invoiceId === 'string' && HASH.test(coverage.invoiceId),
          409, 'UNSETTLED_CASH', 'Settle all new cash fees before approving payout.');
        const invoice = (await tx.get(db.collection('cashFeeInvoices').doc(coverage.invoiceId))).data() as CashFeeInvoice | undefined;
        requireValue(invoice?.status === 'paid' && invoice.atmId === atmId && invoice.donationIds.includes(source.id)
          && invoice.txHash === coverage.txHash && invoice.paidBlock,
        409, 'UNSETTLED_CASH', 'Paid fee evidence must cover the exact cash donation.');
        creditedPaise += BigInt(source.cashAmountPaise);
        invoiceIds.add(invoice.invoiceId);
      }
      const remaining = creditedPaise - BigInt(account?.dispensedPaise ?? '0');
      requireValue(remaining > 0n && remaining === payoutTotal(report.inventory), 409, 'PAYOUT_CASH_ATTRIBUTION_MISMATCH',
        'Full payout inventory must equal credited cash minus verified prior dispensing. Cashbox is excluded.');
      const approvalId = body.requestId as string;
      const payoutId = randomUUID();
      const expiresAt = Date.now() + HumanWindowMs;
      const baselineHash = credentialHash(canonical(report.inventory));
      const message = [
        'KALASH full cash payout approval', `Origin: ${new URL(origin).origin}`, `Chain: ${CHAIN_ID}`,
        `Temple: ${atm.templeId}`, `ATM: ${atmId}`, `Device: ${report.deviceId}`,
        `Approval: ${approvalId}`, `Payout: ${payoutId}`, `Amount paise: ${remaining}`,
        `Inventory SHA256: ${baselineHash}`, `Invoices: ${[...invoiceIds].sort().join(',')}`,
        `Expires: ${new Date(expiresAt).toISOString()}`,
        'Authorize one full payout only. No token transfer or fee payment is authorized by this signature.',
      ].join('\n');
      const approval: Approval = { approvalId, atmId, templeId: atm.templeId, payoutId, expiresAt, amountPaise: remaining.toString(),
        baseline: report.inventory, inventoryReportHash: baselineHash, invoiceIds: [...invoiceIds].sort(), message, used: false };
      tx.create(ref, approval);
      return { approvalId, url: `${origin}/temple-admin/${atmId}?approval=${approvalId}` };
    });
  }
  export async function approvePayout(atmId: string, wallet: Address, approvalId: string, body: Record<string, unknown>) {
    exactFields(body, ['signature']);
    requireValue(PAYOUT_UUID.test(approvalId) && typeof body.signature === 'string' && /^0x[0-9a-f]+$/i.test(body.signature),
      400, 'INVALID_PAYOUT_SIGNATURE', 'A signed payout approval is required.');
    const ref = db.collection('cashPayoutApprovals').doc(approvalId);
    const initial = (await ref.get()).data() as Approval | undefined;
    requireValue(initial && initial.atmId === atmId, 404, 'PAYOUT_APPROVAL_NOT_FOUND', 'Payout approval not found.');
    admin(initial.templeId, wallet);
    requireValue(await verifyMessage({ address: wallet, message: initial.message, signature: body.signature as Hex }),
      403, 'PAYOUT_SIGNATURE_INVALID', 'Payout signature does not match the registered temple administrator.');
    return db.runTransaction(async (tx) => {
      const atmRef = atmReference(atmId);
      const payoutRef = db.collection('cashPayouts').doc(initial.payoutId);
      const [approvalSnap, atmSnap, payoutSnap] = await Promise.all([tx.get(ref), tx.get(atmRef), tx.get(payoutRef)]);
      const approval = approvalSnap.data() as Approval | undefined;
      const atm = validAtm(atmSnap.data() as AtmRecord | undefined);
      admin(atm.templeId, wallet);
      if (approval?.used) {
        const existing = payoutSnap.data() as PayoutRecord | undefined;
        requireValue(existing?.approver === wallet, 409, 'PAYOUT_APPROVAL_USED', 'Approval was already used.');
        return { payoutId: initial.payoutId, state: existing.state };
      }
      requireValue(approval && approval.message === initial.message && approval.expiresAt > Date.now(),
        409, 'PAYOUT_APPROVAL_EXPIRED', 'Approval expired; no command dispatched.');
      readyIdle(atm);
      const report = reportedInventory(atm);
      requireValue(sameInventory(report.inventory, approval.baseline), 409, 'PAYOUT_BASELINE_CHANGED', 'Inventory changed since approval; do not dispense.');
      const command: PayoutCommand = { commandId: `payout-${approval.payoutId}`, type: 'payout_cash',
        payoutId: approval.payoutId, approvalId, atmId, templeId: approval.templeId,
        amountPaise: approval.amountPaise, baseline: approval.baseline, createdAt: Date.now(), expiresAt: approval.expiresAt };
      tx.create(payoutRef, { command, state: 'pending', approver: wallet, invoiceIds: approval.invoiceIds } satisfies PayoutRecord);
      tx.update(ref, { used: true, usedAt: Date.now(), approver: wallet });
      tx.update(atmRef, { activePayoutId: command.payoutId });
      return { payoutId: command.payoutId, state: 'pending' };
    });
  }
  export async function getPayoutCommand(atmId: string, authorization: string | undefined) {
    await validateControllerCredential(atmId, authorization);
    return db.runTransaction(async (tx) => {
      const atmRef = atmReference(atmId);
      const atm = validAtm((await tx.get(atmRef)).data() as AtmRecord | undefined);
      if (!atm.activePayoutId) return { command: null };
      const payoutRef = db.collection('cashPayouts').doc(atm.activePayoutId);
      const record = (await tx.get(payoutRef)).data() as PayoutRecord | undefined;
      requireValue(record && record.command.atmId === atmId, 409, 'PAYOUT_COMMAND_MISSING', 'Active payout record is missing.');
      if (['pending', 'received', 'validated'].includes(record.state) && record.command.expiresAt <= Date.now()) {
        tx.update(payoutRef, { state: 'precondition_failed', reason: 'authorization_expired_before_dispatch' });
        tx.update(atmRef, { activePayoutId: null, lastPayoutId: atm.activePayoutId });
        return { command: null };
      }
      if (['unknown', 'precondition_failed', 'reported'].includes(record.state) || record.command.expiresAt <= Date.now())
        return { command: null };
      requireValue(!atm.activeVisitId && !atm.cashReconciliationRequired
        && cashMachineStatus(atm.controllerHealth ?? null, Date.now()) === 'ready',
      409, 'PAYOUT_COMMAND_NOT_AUTHORIZED', 'Payout needs exclusive idle ownership and fresh online authorization.');
      return { command: record.command };
    });
  }
  export async function reportPayoutCommand(atmId: string, authorization: string | undefined, body: Record<string, unknown>) {
    await validateControllerCredential(atmId, authorization);
    exactFields(body, ['commandId', 'state', 'observedAt', 'reason', 'evidence', 'endState', 'reconciliationApprovalId'], ['commandId', 'state']);
    requireValue(typeof body.commandId === 'string' && body.commandId.startsWith('payout-')
      && PAYOUT_UUID.test(body.commandId.slice(7)) && typeof body.state === 'string'
      && ['received', 'validated', 'dispatching', 'observed', 'reported', 'precondition_failed', 'unknown'].includes(body.state)
      && (body.observedAt === undefined || (typeof body.observedAt === 'number' && Number.isSafeInteger(body.observedAt) && body.observedAt > 0))
      && (body.reason === undefined || (typeof body.reason === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(body.reason))),
    400, 'INVALID_PAYOUT_REPORT', 'Invalid payout report fields.');
    const payoutId = body.commandId.slice(7);
    const ref = db.collection('cashPayouts').doc(payoutId);
    const reportHash = credentialHash(canonical(body));
    return db.runTransaction(async (tx) => {
      const atmRef = atmReference(atmId); const accountRef = db.collection('cashPayoutAccounts').doc(atmId);
      const [atmSnap, recordSnap, accountSnap] = await Promise.all([tx.get(atmRef), tx.get(ref), tx.get(accountRef)]);
      const atm = validAtm(atmSnap.data() as AtmRecord | undefined);
      const record = recordSnap.data() as PayoutRecord | undefined;
      requireValue(record && record.command.atmId === atmId && record.command.commandId === body.commandId
        && record.command.templeId === atm.templeId, 404, 'PAYOUT_NOT_FOUND', 'Payout command not found for this Controller.');
      const next = body.state as PayoutState;
      const ack = { accepted: true, commandId: record.command.commandId, state: next };
      if (record.reportHash === reportHash && record.state === next) return ack;
      if (record.state === 'precondition_failed' && next === 'precondition_failed'
        && record.reason === 'authorization_expired_before_dispatch') return ack;
      requireValue(atm.activePayoutId === payoutId && !atm.activeVisitId, 409, 'PAYOUT_NOT_ACTIVE', 'Payout no longer owns this machine.');
      let endState: PayoutPartialEndState | undefined;
      if (body.endState !== undefined) {
        requireValue(next === 'unknown', 400, 'INVALID_PAYOUT_REPORT', 'Partial-end evidence belongs only to a locked unknown payout.');
        try { endState = validatePayoutPartial(body.endState, record.command, atm.controllerHealth?.deviceId ?? '', atm.cashStreamId ?? ''); }
        catch { throw new HttpError(400, 'PAYOUT_END_STATE_MISMATCH', 'Partial payout state must exactly reconcile inventory, counters and device binding.'); }
      }
      if (body.reconciliationApprovalId !== undefined) {
        const authorization = record.reconciliation;
        requireValue(next === 'unknown' && record.state === 'unknown' && endState
          && body.reason === 'operator_reconciled_partial_end_state' && authorization
          && body.reconciliationApprovalId === authorization.approvalId
          && authorization.expiresAt > Date.now() && sameInventory(authorization.baseline, endState.before)
          && sameInventory(authorization.current, endState.after) && !record.reconciled,
        409, 'PAYOUT_RECONCILIATION_NOT_AUTHORIZED', 'A fresh operator approval of the exact partial end-state is required.');
        const account = accountSnap.data() as Account | undefined;
        tx.update(ref, { state: next, reportHash, endState, reconciled: true, reconciledAt: Date.now() });
        tx.set(accountRef, { ...account, dispensedPaise: (BigInt(account?.dispensedPaise ?? '0') + BigInt(endState.dispensedPaise)).toString() });
        tx.update(atmRef, { activePayoutId: null, lastPayoutId: payoutId, cashReconciliationRequired: false });
        return ack;
      }
      const transitions: Record<PayoutState, PayoutState[]> = {
        pending: ['received'], received: ['validated', 'precondition_failed', 'unknown'],
        validated: ['dispatching', 'precondition_failed', 'unknown'], dispatching: ['observed', 'unknown'],
        observed: ['reported', 'unknown'], reported: [], precondition_failed: [], unknown: ['unknown'],
      };
      requireValue(transitions[record.state].includes(next), 409, 'PAYOUT_STATE_CONFLICT', 'Payout reports cannot skip dispatch or replay prior execution.');
      if (next === 'dispatching') {
        requireValue(record.command.expiresAt > Date.now() && !atm.cashReconciliationRequired
          && cashMachineStatus(atm.controllerHealth ?? null, Date.now()) === 'ready',
        409, 'PAYOUT_DISPATCH_NOT_AUTHORIZED', 'Fresh online authorization and exclusive machine ownership are required.');
      }
      let evidence = record.evidence;
      if (next === 'observed' || next === 'reported') {
        if (body.evidence !== undefined) {
          requireValue(!evidence || canonical(evidence) === canonical(body.evidence), 409, 'PAYOUT_EVIDENCE_CHANGED', 'Completed payout evidence is immutable.');
          evidence = body.evidence;
        }
        try { validatePayoutCompletion(evidence, record.command, atm.controllerHealth?.deviceId ?? '', atm.cashStreamId ?? ''); }
        catch { throw new HttpError(400, 'PAYOUT_COMPLETION_MISMATCH', 'DISPENSED, COMPLETED, later DISABLED/empty and exact full inventory reconciliation are required.'); }
      } else requireValue(body.evidence === undefined, 400, 'INVALID_PAYOUT_REPORT', 'Completion evidence is not valid before observed dispensing.');
      tx.update(ref, { state: next, reportHash, ...(body.observedAt ? { observedAt: body.observedAt } : {}),
        ...(body.reason ? { reason: body.reason } : {}), ...(evidence ? { evidence } : {}), ...(endState ? { endState } : {}) });
      if (next === 'unknown') tx.update(atmRef, { cashReconciliationRequired: true });
      if (next === 'precondition_failed') tx.update(atmRef, { activePayoutId: null, lastPayoutId: payoutId });
      if (next === 'reported') {
        const account = accountSnap.data() as Account | undefined;
        tx.set(accountRef, { ...account, dispensedPaise: (BigInt(account?.dispensedPaise ?? '0') + BigInt(record.command.amountPaise)).toString() });
        tx.update(atmRef, { activePayoutId: null, lastPayoutId: payoutId });
      }
      return ack;
    });
  }
  export async function createPayoutReconciliation(atmId: string, wallet: Address, body: Record<string, unknown>) {
    exactFields(body, ['payoutId', 'signature'], ['payoutId']);
    requireValue(typeof body.payoutId === 'string' && PAYOUT_UUID.test(body.payoutId)
      && (body.signature === undefined || (typeof body.signature === 'string' && /^0x[0-9a-f]+$/i.test(body.signature))),
    400, 'INVALID_RECONCILIATION_REQUEST', 'An existing payout and explicit administrator signature are required.');
    const ref = db.collection('cashPayouts').doc(body.payoutId);
    const initial = (await ref.get()).data() as PayoutRecord | undefined;
    requireValue(initial && initial.command.atmId === atmId && initial.state === 'unknown' && initial.endState && !initial.reconciled,
      409, 'PAYOUT_RECONCILIATION_UNAVAILABLE', 'A persisted partial-end state is required; keep the unknown payout locked.');
    admin(initial.command.templeId, wallet);
    const approvalRef = db.collection('cashPayoutReconciliationApprovals').doc(initial.command.payoutId);
    let approval = (await approvalRef.get()).data() as { authorization: PayoutReconciliationAuthorization; message: string; used: boolean } | undefined;
    if (!body.signature) {
      if (!approval || (!approval.used && approval.authorization.expiresAt <= Date.now())) {
        const authorization: PayoutReconciliationAuthorization = {
          commandId: initial.command.commandId, payoutId: initial.command.payoutId, approvalId: randomUUID(),
          baseline: initial.endState.before, current: initial.endState.after, createdAt: Date.now(), expiresAt: Date.now() + HumanWindowMs,
        };
        const message = ['KALASH payout partial-end reconciliation', `Origin: ${new URL(origin).origin}`, `Chain: ${CHAIN_ID}`,
          `Temple: ${initial.command.templeId}`, `ATM: ${atmId}`, `Payout: ${authorization.payoutId}`,
          `Approval: ${authorization.approvalId}`, `State SHA256: ${credentialHash(canonical(initial.endState))}`,
          `Already dispensed paise: ${initial.endState.dispensedPaise}`, `Remaining paise: ${initial.endState.remainingPaise}`,
          `Expires: ${new Date(authorization.expiresAt).toISOString()}`,
          'Approve reconciliation only. No additional dispensing or fee payment.'].join('\n');
        approval = { authorization, message, used: false };
        await approvalRef.set(approval);
      }
      return { message: approval.message, authorization: approval.authorization };
    }
    requireValue(approval && !approval.used && approval.authorization.expiresAt > Date.now()
      && await verifyMessage({ address: wallet, message: approval.message, signature: body.signature as Hex }),
    403, 'RECONCILIATION_SIGNATURE_INVALID', 'Fresh administrator reconciliation signature is required.');
    await db.runTransaction(async (tx) => {
      const atm = validAtm((await tx.get(atmReference(atmId))).data() as AtmRecord | undefined);
      const [recordSnap, approvalSnap] = await Promise.all([tx.get(ref), tx.get(approvalRef)]);
      const record = recordSnap.data() as PayoutRecord | undefined;
      const currentApproval = approvalSnap.data() as typeof approval;
      requireValue(record?.state === 'unknown' && record.endState && !record.reconciled
        && atm.activePayoutId === body.payoutId && currentApproval && !currentApproval.used
        && currentApproval.message === approval.message && sameInventory(record.endState.after, approval.authorization.current),
      409, 'PAYOUT_RECONCILIATION_CHANGED', 'Payout or approval changed; no lock was cleared.');
      tx.update(ref, { reconciliation: approval.authorization });
      tx.update(approvalRef, { used: true, approver: wallet });
    });
    return { approved: true, authorization: approval.authorization };
  }
  export async function getPayoutReconciliationCommand(atmId: string, authorization: string | undefined) {
    await validateControllerCredential(atmId, authorization);
    const atm = validAtm((await atmReference(atmId).get()).data() as AtmRecord | undefined);
    if (!atm.activePayoutId) return { command: null };
    const record = (await db.collection('cashPayouts').doc(atm.activePayoutId).get()).data() as PayoutRecord | undefined;
    requireValue(record?.command.atmId === atmId, 409, 'PAYOUT_RECONCILIATION_MISSING', 'Active payout record is missing.');
    return { command: record.state === 'unknown' && !record.reconciled && record.reconciliation
      && record.reconciliation.expiresAt > Date.now() ? record.reconciliation : null };
  }
  let feeTickRunning = false;
  export async function cashFeeTick() {
    if (feeTickRunning || !deployment?.cashFeeVault) return;
    feeTickRunning = true;
    try {
      const pending = await db.collection('cashFeeInvoices').where('status', 'in', ['submitted', 'unknown']).limit(10).get();
      for (const row of pending.docs) {
        const invoice = row.data() as CashFeeInvoice;
        try { await verifyCashFee(invoice.atmId, invoice.payer, row.id, {}); }
        catch (error) {
          console.error(JSON.stringify({ event: 'cash_fee_verification_failed', invoiceId: row.id,
            code: error instanceof HttpError ? error.code : 'RPC_OR_STORE_FAILED' }));
        }
      }
    } finally { feeTickRunning = false; }
  }
