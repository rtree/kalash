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
export type DonationStatus = 'intent' | 'submitting' | 'unknown' | 'submitted' | 'confirmed' | 'failed' | 'expired';
export type MintStatus = 'reserved' | 'prepared' | 'submitted' | 'minted' | 'error';
export interface Donation {
  id: Hex;
  ownerWallet: Address;
  templeId: string;
  templeKey: Hex;
  kind: 0;
  amount: string;
  fee: string;
  net: string;
  recipient: Address;
  deadline: number;
  signature: Hex;
  status: DonationStatus;
  mintStatus?: MintStatus;
  txHash?: Hex;
  mintTxHash?: Hex;
  tokenId?: string;
  createdAt: string;
  confirmedAt?: string;
  error?: string;
  startBlock: string;
  donateAttemptId?: string;
}
export interface PublicConfig {
  chainId: 84532;
  usdc: Address;
  vault: Address | null;
  stamp: Address | null;
  reownProjectId: string | null;
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string };
  origin: string;
}
export interface CollectionResponse {
  donations: Donation[];
  points: Record<string, string>;
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
export function parseDonationUnits(input: unknown): bigint {
  if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
    throw new Error('Central returned an invalid USDC base-unit donation amount.');
  }
  const value = BigInt(input);
  if (value > 1000000n) throw new Error('Central donation exceeds the 1 USDC limit.');
  return value;
}
