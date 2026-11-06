export const VISIT_TTL_MS = 120_000;
export const CASH_ACCEPTANCE_MS = 120_000;
export const CASH_LIMIT_PAISE = '40000';
export const ATM_PHOTO_IDLE_MS = 30_000;
export const VISIT_REFERENCE = /^[a-f0-9]{64}$/;
export const ATM_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
export type VisitMode = 'cash' | 'crypto';
export type VisitState =
  | 'awaiting_wallet'
  | 'linked'
  | 'awaiting_device'
  | 'accepting'
  | 'closing'
  | 'reconciling'
  | 'donation_pending'
  | 'confirmed'
  | 'expired'
  | 'closed';
export type CashMachineStatus = 'unknown' | 'offline' | 'disconnected' | 'ready';

export interface VisitDto {
  id: string;
  templeId: string;
  templeName: string;
  atmId: string;
  atmName: string;
  mode: VisitMode;
  state: VisitState;
  expiresAt: number;
  cashSessionId: string | null;
  cashAcceptanceEnabled: boolean;
  cashLimitPaise: string;
  cashAcceptedPaise?: string;
  donationState: 'pending' | 'confirmed' | 'failed' | null;
  donationId?: string | null;
}
export interface AtmDto {
  id: string;
  name: string;
  templeId: string;
  templeName: string;
  visit: VisitDto | null;
  targetUrl: string | null;
  deepLink: string | null;
  qrUnavailableReason: string | null;
  cashMachineStatus: CashMachineStatus;
  cashDisabledReason: string;
  cashAcceptanceEnabled: boolean;
  cashReceptionAvailable: boolean;
  cryptoDonationEnabled: boolean;
}
export function visitState(state: VisitState, expiresAt: number, now: number): VisitState {
  return state === 'awaiting_wallet' && expiresAt <= now ? 'expired' : state;
}
export function cashMachineStatus(health: {
  receivedAt: number;
  sequence: number;
  usbConnected: boolean;
  connectionOpen: boolean;
  deviceStarted: boolean;
  routesVerified: boolean;
  pollerOwned: boolean;
} | null, now: number): CashMachineStatus {
  if (!health || !Number.isSafeInteger(health.sequence) || health.sequence < 1
    || !Number.isFinite(health.receivedAt)
    || now - health.receivedAt > 15_000 || health.receivedAt > now + 5_000) {
    return 'offline';
  }
  if (!health.usbConnected || !health.connectionOpen || !health.deviceStarted
    || !health.routesVerified || !health.pollerOwned) return 'disconnected';
  return 'ready';
}
export function templeTarget(origin: string, templeId: string, reference?: string): string {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password
    || base.hostname === 'localhost' || base.hostname.endsWith('.localhost')
    || base.hostname.endsWith('.local') || base.hostname === '[::1]' || /^127\./.test(base.hostname)
    || base.pathname !== '/' || base.search || base.hash
    || !/^temple-(?:0[1-9]|10)$/.test(templeId)
    || (reference !== undefined && !VISIT_REFERENCE.test(reference))) {
    throw new Error('A canonical HTTPS origin, known temple and valid reception reference are required.');
  }
  const target = new URL(`/temples/${templeId}`, base);
  if (reference) target.searchParams.set('visit', reference);
  return target.href;
}
export function metaMaskLink(target: string, origin: string): string {
  const url = new URL(target);
  const reference = url.searchParams.get('visit') ?? undefined;
  const templeId = url.pathname.match(/^\/temples\/(temple-(?:0[1-9]|10))$/)?.[1];
  if (!templeId || target !== templeTarget(origin, templeId, reference)) {
    throw new Error('Only canonical KALASH temple and reception links are allowed.');
  }
  return `https://link.metamask.io/dapp/${target.slice('https://'.length)}`;
}
