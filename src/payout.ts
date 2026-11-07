import { parseAbi, type Address, type Hex } from 'viem';
import { validateCashInventory, type CashInventory } from './cash.ts';
import { ATM_ID } from './atm.ts';
import { ClockSkewMs, StatusFreshnessMs } from './timing.ts';

export const PAYOUT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const cashFeeAbi = parseAbi([
  'function payFee(bytes32 invoiceId, bytes32 templeId, uint256 amount, uint256 deadline, bytes signature)',
  'function token() view returns (address)',
  'function authorizer() view returns (address)',
  'function feeRecipient() view returns (address)',
  'function consumed(bytes32 invoiceId) view returns (bool)',
  'event FeePaid(bytes32 indexed invoiceId, address indexed payer, bytes32 indexed templeId, uint256 amount, address recipient)',
]);
export const cashFeeTypes = {
  CashFee: [
    { name: 'invoiceId', type: 'bytes32' }, { name: 'payer', type: 'address' },
    { name: 'templeId', type: 'bytes32' }, { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
export interface PayoutInventoryReport {
  observedAt: number; deviceId: string; deviceState: 'DISABLED';
  escrowEmpty: true; inventory: CashInventory; rawSequence: number;
}
export interface CashFeeInvoice {
  invoiceId: Hex; atmId: string; templeId: string; templeKey: Hex; payer: Address;
  amount: string; cashPaise: string; donationIds: Hex[]; deadline: number;
  status: 'awaiting_payment' | 'submitted' | 'unknown' | 'paid';
  vault: Address; recipient: Address; signature: Hex; startBlock: string;
  sourceKeys?: string[];
  txHash?: Hex; paidBlock?: string;
  settlementRiskAcceptedAt?: number; settlementPayoutRequestId?: string;
}
export interface PayoutCommand {
  commandId: string; type: 'payout_cash'; payoutId: string; atmId: string; templeId: string;
  approvalId: string; createdAt: number; expiresAt: number; amountPaise: string; baseline: CashInventory;
}
export type PayoutState = 'pending' | 'received' | 'validated' | 'dispatching'
  | 'observed' | 'reported' | 'precondition_failed' | 'unknown';
export interface PayoutCompletionEvidence {
  before: CashInventory; after: CashInventory; deviceId: string; streamId: string;
  dispatchRawSequence: number; dispensedRawSequence: number; dispensedObservedAt: number;
  completedRawSequence: number; completedObservedAt: number; idleRawSequence: number; idleObservedAt: number;
  deviceState: 'DISABLED'; escrowEmpty: true;
}
export interface PayoutPartialEndState {
  before: CashInventory; after: CashInventory; deviceId: string; streamId: string;
  rawSequence: number; observedAt: number; deviceState: 'DISABLED'; escrowEmpty: true;
  dispensedPaise: string; remainingPaise: string;
}
export interface PayoutReconciliationAuthorization {
  commandId: string; payoutId: string; approvalId: string; baseline: CashInventory; current: CashInventory;
  createdAt: number; expiresAt: number;
}
export function payoutTotal(inventory: CashInventory) {
  return inventory.levels.reduce((sum, level) => sum + BigInt(level.valuePaise) * BigInt(level.payout), 0n);
}
export function payoutNotes(inventory: CashInventory) {
  return inventory.levels.reduce((sum, level) => sum + BigInt(level.payout), 0n);
}
export function sameInventory(a: CashInventory, b: CashInventory) {
  return a.levels.every((level) => b.levels.some((other) => level.valuePaise === other.valuePaise
    && level.payout === other.payout && level.cashbox === other.cashbox))
    && Object.entries(a.counters).every(([key, value]) => value === b.counters[key as keyof CashInventory['counters']]);
}
export function exactCashFee(paise: bigint) {
  if (paise <= 0n) throw new Error('Cash fee requires positive credited cash.');
  return paise * 3n;
}
function exactObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Payout evidence must be an object.');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key)))
    throw new Error('Missing or unknown payout evidence fields.');
  return body;
}
function integer(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0;
}
function reconcileDelta(before: CashInventory, after: CashInventory) {
  const beforeCount = payoutNotes(before);
  const afterCount = payoutNotes(after);
  if (after.levels.some((level) => {
    const previous = before.levels.find((entry) => entry.valuePaise === level.valuePaise)!;
    return level.cashbox !== previous.cashbox || level.payout > previous.payout;
  }) || after.counters.stored !== before.counters.stored || after.counters.stacked !== before.counters.stacked
    || after.counters.transferredToStack !== before.counters.transferredToStack
    || BigInt(after.counters.dispensed) - BigInt(before.counters.dispensed) !== beforeCount - afterCount)
    throw new Error('Payout levels, cashbox and all counters must reconcile exactly.');
}
export function validatePayoutCompletion(input: unknown, command: PayoutCommand, deviceId: string, streamId: string, now = Date.now()) {
  const body = exactObject(input, ['before', 'after', 'deviceId', 'streamId', 'dispatchRawSequence', 'dispensedRawSequence',
    'dispensedObservedAt', 'completedRawSequence', 'completedObservedAt', 'idleRawSequence', 'idleObservedAt',
    'deviceState', 'escrowEmpty']);
  const before = validateCashInventory(body.before); const after = validateCashInventory(body.after);
  if (body.deviceId !== deviceId || body.streamId !== streamId || !PAYOUT_UUID.test(streamId)
    || !sameInventory(before, command.baseline) || payoutTotal(before) !== BigInt(command.amountPaise)
    || payoutTotal(after) !== 0n || body.deviceState !== 'DISABLED' || body.escrowEmpty !== true
    || !integer(body.dispatchRawSequence) || !integer(body.dispensedRawSequence) || !integer(body.completedRawSequence)
    || !integer(body.idleRawSequence) || body.dispatchRawSequence >= body.dispensedRawSequence
    || body.dispensedRawSequence > body.completedRawSequence || body.completedRawSequence > body.idleRawSequence
    || !integer(body.dispensedObservedAt) || !integer(body.completedObservedAt) || !integer(body.idleObservedAt)
    || body.dispensedObservedAt < command.createdAt - ClockSkewMs || body.completedObservedAt < body.dispensedObservedAt
    || body.idleObservedAt <= body.completedObservedAt || body.idleObservedAt > now + ClockSkewMs)
    throw new Error('Ordered DISPENSED, COMPLETED and later DISABLED/empty evidence must match the approved payout.');
  reconcileDelta(before, after);
  return input as PayoutCompletionEvidence;
}
export function validatePayoutPartial(input: unknown, command: PayoutCommand, deviceId: string, streamId: string, now = Date.now()) {
  const body = exactObject(input, ['before', 'after', 'deviceId', 'streamId', 'rawSequence', 'observedAt',
    'deviceState', 'escrowEmpty', 'dispensedPaise', 'remainingPaise']);
  const before = validateCashInventory(body.before); const after = validateCashInventory(body.after);
  if (body.deviceId !== deviceId || body.streamId !== streamId || !PAYOUT_UUID.test(streamId)
    || !integer(body.rawSequence) || !integer(body.observedAt) || body.observedAt < command.createdAt - ClockSkewMs
    || body.observedAt > now + ClockSkewMs || body.deviceState !== 'DISABLED' || body.escrowEmpty !== true
    || !sameInventory(before, command.baseline) || payoutTotal(before) !== BigInt(command.amountPaise)
    || typeof body.dispensedPaise !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(body.dispensedPaise)
    || typeof body.remainingPaise !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(body.remainingPaise)
    || BigInt(body.remainingPaise) !== payoutTotal(after)
    || BigInt(body.dispensedPaise) !== payoutTotal(before) - payoutTotal(after))
    throw new Error('Partial end state must prove disabled, empty escrow and exact reconciled remaining cash.');
  reconcileDelta(before, after);
  return input as PayoutPartialEndState;
}
export function validatePayoutInventory(input: unknown, now = Date.now()): PayoutInventoryReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Payout inventory must be an object.');
  const body = input as Record<string, unknown>;
  const keys = ['observedAt', 'deviceId', 'deviceState', 'escrowEmpty', 'inventory', 'rawSequence'];
  if (Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key))
    || typeof body.observedAt !== 'number' || !Number.isSafeInteger(body.observedAt)
    || body.observedAt < now - StatusFreshnessMs || body.observedAt > now + ClockSkewMs
    || typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.deviceId)
    || body.deviceState !== 'DISABLED' || body.escrowEmpty !== true
    || typeof body.rawSequence !== 'number' || !Number.isSafeInteger(body.rawSequence) || body.rawSequence < 1)
    throw new Error('Fresh DISABLED, empty escrow and complete inventory evidence are required.');
  validateCashInventory(body.inventory);
  return input as PayoutInventoryReport;
}
export function payoutApprovalLink(origin: string, atmId: string, approvalId: string) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/'
    || base.search || base.hash || !ATM_ID.test(atmId) || !PAYOUT_UUID.test(approvalId))
    throw new Error('A canonical HTTPS origin, ATM and payout approval are required.');
  const target = new URL(`/temple-admin/${atmId}`, base);
  target.searchParams.set('approval', approvalId);
  return `https://link.metamask.io/dapp/${target.href.slice('https://'.length)}`;
}
