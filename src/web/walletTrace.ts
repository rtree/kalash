export interface WalletTraceEntry {
  attemptId: string | null;
  at: string;
  event: string;
  connector: string | null;
  chainId: number | null;
  connected: boolean;
  addressPresent: boolean;
}

declare global {
  interface Window {
    __KALASH_WALLET_TRACE__?: WalletTraceEntry[];
  }
}

const TRACE_LIMIT = 100;
const trace = window.__KALASH_WALLET_TRACE__ ?? [];
window.__KALASH_WALLET_TRACE__ = trace;

let activeAttemptId: string | null = null;
let lifecycleListenersInstalled = false;
let lastWalletState = {
  connector: null as string | null,
  chainId: null as number | null,
  connected: false,
  addressPresent: false,
};

export function sanitizeConnector(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('walletconnect')) return 'walletConnect';
  if (normalized.includes('metamask')) return 'metamask';
  if (normalized === 'injected' || normalized === 'eip6963') return 'injected';
  if (normalized.includes('coinbase')) return 'coinbase';
  if (normalized.includes('baseaccount')) return 'baseAccount';
  return 'other';
}

function normalizeChainId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^(?:eip155:)?(\d+)$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function recordWalletTrace(
  event: string,
  state: {
    connector?: unknown;
    chainId?: unknown;
    connected?: boolean;
    addressPresent?: boolean;
  } = {},
  attemptId = activeAttemptId,
): void {
  if ('connector' in state) lastWalletState.connector = sanitizeConnector(state.connector);
  if ('chainId' in state) lastWalletState.chainId = normalizeChainId(state.chainId);
  if ('connected' in state) lastWalletState.connected = state.connected === true;
  if ('addressPresent' in state) lastWalletState.addressPresent = state.addressPresent === true;
  trace.push({
    attemptId,
    at: new Date().toISOString(),
    event,
    ...lastWalletState,
  });
  if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT);
}

export function startWalletAttempt(connector: unknown): string {
  activeAttemptId = crypto.randomUUID();
  recordWalletTrace('attempt-start', { connector, connected: false, addressPresent: false });
  return activeAttemptId;
}

export function installWalletLifecycleTrace(): void {
  if (lifecycleListenersInstalled) return;
  lifecycleListenersInstalled = true;
  const recordLifecycle = (event: 'visibilitychange' | 'focus') => {
    recordWalletTrace(event);
  };
  document.addEventListener('visibilitychange', () => recordLifecycle('visibilitychange'));
  window.addEventListener('focus', () => recordLifecycle('focus'));
}
