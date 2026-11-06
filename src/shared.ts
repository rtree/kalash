import { parseAbi, type Address, type Hex } from 'viem';

export const CHAIN_ID = 84532;
export const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const vaultAbi = parseAbi([
  'function donate(bytes32 donationId, bytes32 templeId, uint8 kind, uint256 amount, uint256 deadline, bytes signature)',
  'event Donated(bytes32 indexed donationId, address indexed donor, bytes32 indexed templeId, uint8 kind, uint256 amount, uint256 fee, address recipient)',
]);
export const vaultFeeRecipientAbi = parseAbi([
  'function feeRecipient() view returns (address)',
]);
export const PHOTO_CONSENT_VERSION = 'photo-board-v1';
export const PHOTO_SIZE_TIERS = [
  { tier: 1, minimumUnits: 1n, displayWidth: 88 },
  { tier: 2, minimumUnits: 5_000_000n, displayWidth: 120 },
  { tier: 3, minimumUnits: 20_000_000n, displayWidth: 156 },
  { tier: 4, minimumUnits: 50_000_000n, displayWidth: 192 },
] as const;
export const stampAbi = parseAbi([
  'function mint(bytes32 donationId,address recipient,bytes32 templeId,uint8 kind,uint256 day)',
  'event StampMinted(bytes32 indexed donationId,address indexed recipient,uint256 indexed tokenId,bytes32 templeId,uint8 kind,uint256 day)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'function balanceOf(address account,uint256 id) view returns (uint256)',
]);
export const donationTypes = {
  Donation: [
    { name: 'donationId', type: 'bytes32' },
    { name: 'donor', type: 'address' },
    { name: 'templeId', type: 'bytes32' },
    { name: 'kind', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
export interface Temple {
  id: string;
  name: string;
  description: string;
  latitude: number;
  longitude: number;
  onsite: boolean;
  recipient: Address;
  motif: string;
}
export type DonationStatus = 'intent' | 'submitting' | 'unknown' | 'submitted' | 'confirmed' | 'failed' | 'expired' | 'cancelled';
export type MintStatus = 'reserved' | 'prepared' | 'submitted' | 'minted' | 'error';
export interface DonationBase {
  id: Hex;
  ownerWallet: Address;
  templeId: string;
  templeKey: Hex;
  kind: 0 | 1;
  onsiteVisitId?: string;
  amount: string;
  fee: string;
  net: string;
  recipient: Address;
  status: DonationStatus;
  mintStatus?: MintStatus;
  mintTxHash?: Hex;
  tokenId?: string;
  createdAt: string;
  confirmedAt?: string;
  error?: string;
  donateAttemptId?: string;
  approvalAttemptId?: string;
  approvalResolution?: {
    attemptId: string;
    resolvedAt: string;
    fromBlock: string;
    throughBlock: string;
    outcome: 'cancelled' | 'expired';
    signatureValidUntil: number;
    onchainRevoked: false;
    confirmedNoWalletRequest: true;
    approvalEvents: 0;
    allowanceUnits: '0';
    donatedEvents: 0;
  };
  expiredAt?: string;
  cancelledAt?: string;
}
export interface CryptoDonation extends DonationBase {
  paymentMethod?: 'crypto';
  chainId?: typeof CHAIN_ID;
  deadline: number;
  signature: Hex;
  startBlock: string;
  txHash?: Hex;
}
export interface CashDonation extends DonationBase {
  paymentMethod: 'cash';
  kind: 1;
  onsiteVisitId: string;
  cashSessionId: string;
  cashAmountPaise: string;
  cashFeeStatus: 'unpaid';
  chainId: null;
  txHash: null;
  status: 'confirmed';
}
export type Donation = CryptoDonation | CashDonation;
export interface PhotoDto {
  id: string;
  templeId: string;
  displayName: string | null;
  sizeTier: 1 | 2 | 3 | 4;
  imageUrl: string;
  createdAt: string;
  expiresAt: string;
}
export interface PublicConfig {
  cashPolicy?: 'strict' | 'interim-ledger';
  chainId: 84532;
  usdc: Address;
  vault: Address | null;
  stamp: Address | null;
  cashFeeVault?: Address | null;
  reownProjectId: string | null;
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket: string };
  origin: string;
}
export interface CollectionResponse {
  donations: Donation[];
  points: Record<string, string>;
  photos: PhotoDto[];
}
export function photoSizeTier(pointUnits: string | bigint): 1 | 2 | 3 | 4 | null {
  const units = BigInt(pointUnits);
  if (units <= 0n) return null;
  if (units >= PHOTO_SIZE_TIERS[3].minimumUnits) return 4;
  if (units >= PHOTO_SIZE_TIERS[2].minimumUnits) return 3;
  if (units >= PHOTO_SIZE_TIERS[1].minimumUnits) return 2;
  return 1;
}
export function parseAmount(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input)) {
    throw new Error('Enter USDC with at most six decimals; no rounding is performed.');
  }
  const [whole, fraction = ''] = input.split('.');
  const value = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (value <= 0n || value > 1000000n) throw new Error('Donation must be greater than 0 and at most 1 USDC.');
  return value;
}
export function formatUsdc(value: string | bigint): string {
  const amount = BigInt(value);
  return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, '0')}`;
}
export function formatPaise(value: string | bigint): string {
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
export function donationPointUnits(amount: string | bigint, kind: 0 | 1): bigint {
  return BigInt(amount) * (kind === 0 ? 1n : 10n);
}
export function parseDonationUnits(input: unknown): bigint {
  if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
    throw new Error('Central returned an invalid USDC base-unit donation amount.');
  }
  const value = BigInt(input);
  if (value > 1000000n) throw new Error('Central donation exceeds the 1 USDC limit.');
  return value;
}
