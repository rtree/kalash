import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type Log,
} from 'viem';
import { USDC, vaultAbi, type Donation } from '../src/shared.ts';
import { validateDonationReceiptEvidence } from '../src/server/donation-receipt.ts';

const owner = '0x1111111111111111111111111111111111111111' as Address;
const vault = '0x2222222222222222222222222222222222222222' as Address;
const feeRecipient = '0x3333333333333333333333333333333333333333' as Address;
const templeRecipient = '0x4444444444444444444444444444444444444444' as Address;
const donation: Pick<Donation, 'id' | 'templeKey' | 'kind' | 'amount' | 'fee' | 'net' | 'recipient' | 'deadline'> = {
  id: `0x${'a'.repeat(64)}`,
  templeKey: `0x${'b'.repeat(64)}`,
  kind: 0,
  amount: '10000',
  fee: '1',
  net: '9999',
  recipient: templeRecipient,
  deadline: 2_000_000_000,
};
const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function makeLog(address: Address, topics: readonly Hex[], data: Hex, logIndex: number): Log {
  const [signature, ...indexedTopics] = topics;
  return {
    address,
    topics: [signature!, ...indexedTopics],
    data,
    blockHash: `0x${'c'.repeat(64)}`,
    blockNumber: 1n,
    transactionHash: `0x${'d'.repeat(64)}`,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

function donatedLog(overrides: Partial<{
  donationId: Hex; donor: Address; templeId: Hex; kind: number; amount: bigint; fee: bigint; recipient: Address;
}> = {}): Log {
  const args = {
    donationId: donation.id,
    donor: owner,
    templeId: donation.templeKey,
    ...overrides,
  };
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: 'Donated', args }) as readonly Hex[];
  const data = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
    [overrides.kind ?? donation.kind, overrides.amount ?? BigInt(donation.amount),
      overrides.fee ?? BigInt(donation.fee), overrides.recipient ?? donation.recipient],
  );
  return makeLog(vault, topics, data, 0);
}

function transferLog(to: Address, value: bigint, logIndex: number, from = owner): Log {
  const topics = encodeEventTopics({
    abi: transferAbi, eventName: 'Transfer', args: { from, to },
  }) as readonly Hex[];
  const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
  return makeLog(USDC, topics, data, logIndex);
}

function validLogs(): Log[] {
  return [
    transferLog(feeRecipient, 1n, 1),
    transferLog(templeRecipient, 9999n, 2),
    donatedLog(),
  ];
}

test('accepts a wrapped wallet receipt only when the configured vault event and exact USDC legs match', () => {
  assert.equal(validateDonationReceiptEvidence(
    validLogs(), donation, owner, vault, feeRecipient, 1_900_000_000n,
  ), 0);
});

test('rejects mismatched vault identity and every immutable donation field', () => {
  const mutations: Array<[string, Log]> = [
    ['donation ID', donatedLog({ donationId: `0x${'e'.repeat(64)}` })],
    ['donor', donatedLog({ donor: feeRecipient })],
    ['temple', donatedLog({ templeId: `0x${'f'.repeat(64)}` })],
    ['kind', donatedLog({ kind: 1 })],
    ['amount', donatedLog({ amount: 10001n })],
    ['fee', donatedLog({ fee: 2n })],
    ['recipient', donatedLog({ recipient: feeRecipient })],
  ];
  for (const [field, event] of mutations) {
    assert.throws(() => validateDonationReceiptEvidence(
      [...validLogs().slice(0, 2), event], donation, owner, vault, feeRecipient, 1_900_000_000n,
    ), { message: /Donation event values do not match/ }, field);
  }
  assert.throws(() => validateDonationReceiptEvidence(
    validLogs(), donation, owner, '0x5555555555555555555555555555555555555555', feeRecipient, 1_900_000_000n,
  ), { message: /Expected exactly one Donated event/ });
  assert.throws(() => validateDonationReceiptEvidence(
    validLogs(), donation, owner, vault, feeRecipient, 2_000_000_001n,
  ), { message: /Donation event values do not match/ });
});

test('rejects a missing, altered, or additional donor USDC transfer', () => {
  assert.throws(() => validateDonationReceiptEvidence(
    [donatedLog(), transferLog(templeRecipient, 9999n, 2)], donation, owner, vault, feeRecipient, 1_900_000_000n,
  ), { message: /USDC transfers do not match/ });
  assert.throws(() => validateDonationReceiptEvidence(
    [donatedLog(), transferLog(feeRecipient, 1n, 1), transferLog(templeRecipient, 9998n, 2)],
    donation, owner, vault, feeRecipient, 1_900_000_000n,
  ), { message: /USDC transfers do not match/ });
  assert.throws(() => validateDonationReceiptEvidence(
    [...validLogs(), transferLog(owner, 1n, 3)], donation, owner, vault, feeRecipient, 1_900_000_000n,
  ), { message: /USDC transfers do not match/ });
  assert.throws(() => validateDonationReceiptEvidence(
    validLogs(), donation, owner, vault, '0x5555555555555555555555555555555555555555', 1_900_000_000n,
  ), { message: /USDC transfers do not match/ });
});
