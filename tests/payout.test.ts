import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex, type Log } from 'viem';
import { CASH_DENOMINATIONS, type CashInventory } from '../src/cash.ts';
import { USDC } from '../src/shared.ts';
import {
  cashFeeAbi, exactCashFee, payoutApprovalLink, payoutTotal, sameInventory, validatePayoutInventory,
  validatePayoutCompletion, validatePayoutPartial, type CashFeeInvoice, type PayoutCommand, type PayoutCompletionEvidence,
  type PayoutPartialEndState, type PayoutInventoryReport,
} from '../src/payout.ts';
import { validateCashFeeReceipt } from '../src/server/cash-fee-receipt.ts';

const payer = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const vault = '0x0000000000000000000000000000000000000003';
const invoiceId = `0x${'a'.repeat(64)}` as Hex;
const templeKey = `0x${'b'.repeat(64)}` as Hex;
const invoice: CashFeeInvoice = {
  invoiceId, atmId: 'atm-01', templeId: 'temple-01', templeKey, payer, recipient, vault,
  amount: '30000', cashPaise: '10000', donationIds: [], deadline: 2_000_000_000,
  status: 'submitted', signature: '0x00', startBlock: '1',
};
test('actual C# serialized payout inventory, completion and partial DTOs match Central exactly', () => {
  const wire: { command: PayoutCommand; inventory: PayoutInventoryReport; completion: PayoutCompletionEvidence; partial: PayoutPartialEndState } =
    JSON.parse(readFileSync(process.env.KALASH_PAYOUT_WIRE_OUTPUT
      ?? new URL('fixtures/payout-wire.synthetic.json', import.meta.url), 'utf8'));
  assert.deepEqual(validatePayoutInventory(wire.inventory, wire.inventory.observedAt), wire.inventory);
  assert.deepEqual(validatePayoutCompletion(wire.completion, wire.command, wire.completion.deviceId,
    wire.completion.streamId, wire.completion.idleObservedAt), wire.completion);
  assert.deepEqual(validatePayoutPartial(wire.partial, wire.command, wire.partial.deviceId,
    wire.partial.streamId, wire.partial.observedAt), wire.partial);
  assert.equal(Object.hasOwn(wire.inventory, 'bezelEmpty'), false);
});
function inventory(notes = 1): CashInventory {
  return { levels: CASH_DENOMINATIONS.map((valuePaise) => ({ valuePaise, payout: valuePaise === '10000' ? notes : 0, cashbox: 2 })),
    counters: { stored: notes, stacked: 0, dispensed: 0, transferredToStack: 0 } };
}
function strictTopics(topics: ReturnType<typeof encodeEventTopics>): Log['topics'] {
  const values = topics.map((topic) => {
    assert.equal(typeof topic, 'string');
    if (typeof topic !== 'string') throw new Error('Only concrete event topics are allowed in this fixture.');
    return topic;
  });
  const first = values.shift();
  assert.ok(first);
  return [first, ...values];
}
function logs(): Log[] {
  const common = { blockHash: `0x${'c'.repeat(64)}` as Hex, blockNumber: 1n, transactionHash: `0x${'d'.repeat(64)}` as Hex,
    transactionIndex: 0, removed: false };
  return [
    { ...common, address: vault, logIndex: 0,
      topics: strictTopics(encodeEventTopics({ abi: cashFeeAbi, eventName: 'FeePaid', args: { invoiceId, payer, templeId: templeKey } })),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [30000n, recipient]) },
    { ...common, address: USDC, logIndex: 1,
      topics: strictTopics(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: payer, to: recipient } })),
      data: encodeAbiParameters([{ type: 'uint256' }], [30000n]) },
  ];
}
test('cash fee is exact 3% at INR100/USDC without the Crypto donation cap', () => {
  assert.equal(exactCashFee(10000n), 30000n);
  assert.equal(exactCashFee(40000n), 120000n);
  assert.equal(exactCashFee(500000n), 1500000n);
  assert.throws(() => exactCashFee(0n));
});
test('full payout excludes cashbox and retains mixed denominations and counters', () => {
  const state = inventory(2);
  state.levels[0]!.payout = 3;
  assert.equal(payoutTotal(state), 23000n);
  assert.equal(sameInventory(state, { ...state, levels: state.levels.toReversed() }), true);
  const changed = structuredClone(state); changed.counters.dispensed++;
  assert.equal(sameInventory(state, changed), false);
});
test('readiness proves disabled, empty escrow and inventory without a bezel-empty assertion', () => {
  const now = 10_000_000;
  const report = { observedAt: now, deviceId: 'synthetic-device', deviceState: 'DISABLED',
    escrowEmpty: true, inventory: inventory(), rawSequence: 1 };
  assert.deepEqual(validatePayoutInventory(report, now), report);
  for (const patch of [{ escrowEmpty: false }, { deviceState: 'IDLE' }, { observedAt: now - 30001 },
    { observedAt: now + 30001 }, { rawSequence: 0 }, { unknown: true }, { inventory: { levels: [] } }])
    assert.throws(() => validatePayoutInventory({ ...report, ...patch }, now));
  const { escrowEmpty: _, ...missing } = report;
  assert.throws(() => validatePayoutInventory(missing, now));
});
test('exact FeePaid and real matching USDC Transfer are both required', () => {
  assert.equal(validateCashFeeReceipt(logs(), invoice, 1n), 0);
  const patches: Partial<CashFeeInvoice>[] = [{ amount: '29999' }, { payer: recipient }, { invoiceId: `0x${'e'.repeat(64)}` as Hex },
    { recipient: payer }, { templeKey: invoiceId }];
  for (const patch of patches)
    assert.throws(() => validateCashFeeReceipt(logs(), { ...invoice, ...patch }, 1n));
  assert.throws(() => validateCashFeeReceipt(logs().slice(0, 1), invoice, 1n));
  assert.throws(() => validateCashFeeReceipt([...logs(), logs()[1]!], invoice, 1n));
  assert.throws(() => validateCashFeeReceipt(logs(), invoice, BigInt(invoice.deadline) + 1n));
  const wrongToken = logs(); wrongToken[1]!.address = vault;
  assert.throws(() => validateCashFeeReceipt(wrongToken, invoice, 1n));
});
test('payout QR contains only the canonical origin, ATM and opaque approval reference', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  assert.equal(payoutApprovalLink('https://kalash.example', 'atm-01', id),
    `https://link.metamask.io/dapp/kalash.example/temple-admin/atm-01?approval=${id}`);
  for (const origin of ['http://kalash.example', 'https://user@kalash.example', 'https://kalash.example/other', 'https://kalash.example?token=secret'])
    assert.throws(() => payoutApprovalLink(origin, 'atm-01', id));
  assert.throws(() => payoutApprovalLink('https://kalash.example', '../atm-01', id));
});
