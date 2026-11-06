import { getAddress, parseAbi, parseEventLogs, type Address, type Log } from 'viem';
import { USDC, type CryptoDonation } from '../shared.ts';
import { requireValue } from './errors.ts';

const donatedAbi = parseAbi([
  'event Donated(bytes32 indexed donationId, address indexed donor, bytes32 indexed templeId, uint8 kind, uint256 amount, uint256 fee, address recipient)',
]);
const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export function validateDonationReceiptEvidence(
  receiptLogs: readonly Log[],
  donation: Pick<CryptoDonation, 'id' | 'templeKey' | 'kind' | 'amount' | 'fee' | 'net' | 'recipient' | 'deadline'>,
  owner: Address,
  vault: Address,
  feeRecipient: Address,
  blockTimestamp: bigint,
): number {
  const vaultLogs = receiptLogs.filter((log) => log.address.toLowerCase() === vault.toLowerCase());
  const events = parseEventLogs({
    abi: donatedAbi, eventName: 'Donated', logs: vaultLogs, strict: true,
  });
  requireValue(events.length === 1, 400, 'EVENT_MISMATCH', 'Expected exactly one Donated event.');

  const event = events[0]!;
  const args = event.args;
  const amount = BigInt(donation.amount);
  const fee = amount / 10000n;
  const net = amount - fee;
  requireValue(BigInt(donation.fee) === fee && BigInt(donation.net) === net
    && args.donationId === donation.id && args.donor.toLowerCase() === owner.toLowerCase()
    && args.templeId === donation.templeKey && args.kind === donation.kind
    && args.amount === amount && args.fee === fee
    && getAddress(args.recipient) === getAddress(donation.recipient)
    && blockTimestamp <= BigInt(donation.deadline),
  400, 'EVENT_MISMATCH', 'Donation event values do not match the registered intent.');

  const tokenLogs = receiptLogs.filter((entry) => entry.address.toLowerCase() === USDC.toLowerCase());
  const transfers = parseEventLogs({
    abi: transferAbi, eventName: 'Transfer', logs: tokenLogs, strict: true,
  }).filter((entry) => entry.args.from.toLowerCase() === owner.toLowerCase());
  const expectedTransfers = [
    ...(fee === 0n ? [] : [{ to: feeRecipient, value: fee }]),
    { to: donation.recipient, value: net },
  ];
  requireValue(transfers.length === expectedTransfers.length
    && expectedTransfers.every(({ to, value }) => transfers.filter((entry) =>
      getAddress(entry.args.to) === getAddress(to) && entry.args.value === value).length === 1),
  400, 'TRANSFER_MISMATCH', 'USDC transfers do not match the donation amount and destinations.');

  return event.logIndex;
}
