import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getIdToken,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import { parseAbi, type Address, type Hex } from 'viem';
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from 'wagmi';
import {
  CHAIN_ID, formatUsdc, parseAmount, parseDonationUnits, PHOTO_CONSENT_VERSION,
  PHOTO_SIZE_TIERS, stampAbi, vaultAbi, type CollectionResponse, type Donation,
  type DonationStatus, type PhotoDto, type Temple,
} from '../shared.ts';
import type { Runtime } from './runtime.ts';
import { recordWalletTrace, startWalletAttempt } from './walletTrace.ts';

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
const AMOUNTS = ['0.01', '0.1', '0.5', '1'];
const INR_PER_USDC = 100n;
const MAP_VENUE = { latitude: 19.0641916, longitude: 72.8674424 };
const CURRENT_DONATION = 'kalash:currentDonationId';
const AUTH_WALLET = 'kalash:authWallet';
const PENDING_OPERATION = 'kalash:pendingOperation';
const POLL_LIMIT = 12;

interface PendingOperation {
  donationId: Hex;
  operation: 'approve' | 'donate';
  attemptId: string;
  txHash?: Hex;
}

interface PhotoEligibility {
  templeId: string;
  points: string;
  sizeTier: 1 | 2 | 3 | 4;
}

interface PhotoUploadResponse {
  photo: PhotoDto;
  cleanupPending: boolean;
}

async function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the selected image.'));
        return;
      }
      const separator = reader.result.indexOf(',');
      if (separator < 0) {
        reject(new Error('Could not encode the selected image.'));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatInr(amountUnits: bigint): string {
  const tenThousandths = amountUnits * INR_PER_USDC * 10000n / 1000000n;
  const fraction = (tenThousandths % 10000n).toString().padStart(4, '0').replace(/0+$/, '').padEnd(2, '0');
  return `₹${tenThousandths / 10000n}.${fraction}`;
}

function mercatorPoint(latitude: number, longitude: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (longitude + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function MapTiles({ temples, onTemple }: { temples: Temple[]; onTemple: (temple: Temple) => void }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const zoom = 14;
  const center = mercatorPoint(MAP_VENUE.latitude, MAP_VENUE.longitude, zoom);

  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tileLayout = useMemo(() => {
    if (!dimensions.width || !dimensions.height) return [];
    const left = center.x - dimensions.width / 2;
    const top = center.y - dimensions.height / 2;
    const firstX = Math.floor(left / 256);
    const firstY = Math.floor(top / 256);
    const lastX = Math.floor((left + dimensions.width) / 256);
    const lastY = Math.floor((top + dimensions.height) / 256);
    const tileCount = 2 ** zoom;
    const tiles = [];
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        const wrappedX = ((x % tileCount) + tileCount) % tileCount;
        if (y < 0 || y >= tileCount) continue;
        tiles.push({
          key: `${zoom}/${wrappedX}/${y}`,
          x: x * 256 - left,
          y: y * 256 - top,
          src: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
        });
      }
    }
    return tiles;
  }, [center.x, center.y, dimensions, zoom]);

  const pointFor = (temple: Temple) => {
    const point = mercatorPoint(temple.latitude, temple.longitude, zoom);
    return {
      left: `${point.x - center.x + dimensions.width / 2}px`,
      top: `${point.y - center.y + dimensions.height / 2}px`,
    };
  };

  return (
    <div className="map-frame">
      <div className="map-canvas" ref={mapRef} aria-label="Illustrative map of the demo temple area">
        <div className="map-tiles">
          {tileLayout.map((tile) => <img key={tile.key} src={tile.src} alt="" draggable={false} style={{ left: tile.x, top: tile.y }} />)}
        </div>
        <div className="map-venue" style={{
          left: dimensions.width / 2,
          top: dimensions.height / 2,
        }}><span />Jio World Convention Centre area</div>
        {temples.map((temple, index) => (
          <button
            key={temple.id}
            className="map-pin"
            style={pointFor(temple)}
            onClick={() => onTemple(temple)}
            aria-label={`Open ${temple.name}`}
            title={temple.name}
          ><span>{index + 1}</span></button>
        ))}
      </div>
      <div className="map-attribution">
        <span>Fictional demo points · no temple affiliation</span>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
      </div>
    </div>
  );
}

interface ApiError {
  error?: string;
  message?: string;
}

function readStorage<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function isWalletRejection(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === 'UserRejectedRequestError') return true;
  return Boolean(cause && typeof cause === 'object' && 'code' in cause
    && (cause.code === 4001 || cause.code === 'ACTION_REJECTED'));
}

function formatPoints(units: string): string {
  const value = BigInt(units);
  const whole = value / 10000n;
  const fraction = (value % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function donationStatusLabel(status: DonationStatus, mintStatus?: Donation['mintStatus']): string {
  if (mintStatus === 'minted') return 'Stamp minted';
  if (status === 'confirmed') return mintStatus === 'error' ? 'Donation confirmed · mint needs attention' : 'Donation confirmed · stamp pending';
  if (status === 'unknown' || status === 'submitting') return 'Waiting for transaction confirmation';
  if (status === 'submitted') return 'Central is verifying your donation';
  if (status === 'failed') return 'Donation failed';
  if (status === 'expired') return 'Donation intent expired';
  return 'Ready to submit';
}

function statusTone(status: DonationStatus, mintStatus?: Donation['mintStatus']): string {
  if (mintStatus === 'minted' || status === 'confirmed') return 'success';
  if (status === 'failed' || status === 'expired' || mintStatus === 'error') return 'danger';
  if (status === 'unknown' || status === 'submitting' || status === 'submitted' || mintStatus === 'reserved' || mintStatus === 'prepared' || mintStatus === 'submitted') return 'waiting';
  return '';
}

function Illustration({ motif, className = '' }: { motif: string; className?: string }) {
  return (
    <div className={`temple-art motif-${motif} ${className}`} role="img" aria-label="Decorative illustration, not a photograph">
      <span className="art-sun" />
      <span className="art-hill art-hill-back" />
      <span className="art-hill art-hill-front" />
      <span className="art-temple">
        <span className="art-roof" />
        <span className="art-dome" />
        <span className="art-columns"><i /><i /><i /><i /></span>
        <span className="art-door" />
      </span>
      <span className="art-lotus">✺</span>
      <span className="art-caption">Illustrative artwork · not a photograph</span>
    </div>
  );
}

export function App({ runtime }: { runtime: Runtime }) {
  const { config, auth, temples } = runtime;
  const { address, chainId, isConnected, connector, status: walletStatus } = useAccount();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [path, setPath] = useState(window.location.pathname);
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);
  const [firebaseUser, setFirebaseUser] = useState(auth.currentUser);
  const [connectingAuth, setConnectingAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [exploreView, setExploreView] = useState<'map' | 'list'>('map');
  const [amount, setAmount] = useState('0.01');
  const [customAmount, setCustomAmount] = useState('');
  const [currentDonationId, setCurrentDonationId] = useState<Hex | null>(() => localStorage.getItem(CURRENT_DONATION) as Hex | null);
  const [donation, setDonation] = useState<Donation | null>(null);
  const [collection, setCollection] = useState<CollectionResponse | null>(null);
  const [history, setHistory] = useState<Donation[]>([]);
  const [photoEligibility, setPhotoEligibility] = useState<PhotoEligibility | null>(null);
  const [boardPhotos, setBoardPhotos] = useState<PhotoDto[]>([]);
  const [boardError, setBoardError] = useState('');
  const [boardLoading, setBoardLoading] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(() => readStorage(PENDING_OPERATION));
  const [refreshVersion, setRefreshVersion] = useState(0);
  const previousAddress = useRef<string | null>(null);
  const currentTempleId = path.match(/^\/temples\/([^/]+)\/?$/)?.[1];
  const currentTemple = temples.find((temple) => temple.id === currentTempleId);
  const boardTempleId = path.match(/^\/board\/([^/]+)\/?$/)?.[1];

  const api = useCallback(async <T,>(url: string, init: RequestInit = {}, privateRequest = false): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (privateRequest) {
      const user = auth.currentUser;
      if (!user) throw new Error('Connect and verify your wallet to continue.');
      headers.set('Authorization', `Bearer ${await getIdToken(user)}`);
    }
    const response = await fetch(url, { ...init, headers });
    const body = await response.json().catch(() => ({})) as T & ApiError;
    if (!response.ok) {
      throw new Error(body.message ?? body.error ?? `Request failed (${response.status}).`);
    }
    return body;
  }, [auth]);
  const getPhotoEligibility = useCallback(
    (donationId: Hex) => api<PhotoEligibility>(`/api/photos/eligibility/${encodeURIComponent(donationId)}`, {}, true),
    [api],
  );

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, '', nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: 'instant' });
    setError('');
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
      setError('');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, setFirebaseUser, (cause) => setError(cause.message));
  }, [auth]);

  useEffect(() => {
    if (walletStatus === 'connecting' || walletStatus === 'reconnecting') return;
    const wallet = address?.toLowerCase() ?? null;
    const previous = previousAddress.current;
    previousAddress.current = wallet;
    if ((previous && previous !== wallet) || (firebaseUser && wallet
      && firebaseUser.uid !== `wallet_${wallet}`)) {
      void signOut(auth).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not clear the previous wallet session.');
      });
      localStorage.removeItem(AUTH_WALLET);
      localStorage.removeItem(CURRENT_DONATION);
      localStorage.removeItem(PENDING_OPERATION);
      setAuthenticatedWallet(null);
      setCurrentDonationId(null);
      setDonation(null);
      setPendingOperation(null);
      setCollection(null);
      setHistory([]);
    } else if (firebaseUser && wallet && firebaseUser.uid === `wallet_${wallet}`) {
      localStorage.setItem(AUTH_WALLET, wallet);
      setAuthenticatedWallet(wallet);
    } else {
      setAuthenticatedWallet(null);
    }
  }, [address, auth, firebaseUser, walletStatus]);

  useEffect(() => {
    if (!currentDonationId || !authenticatedWallet) return;
    let active = true;
    void api<Donation>(`/api/donations/${encodeURIComponent(currentDonationId)}`, {}, true)
      .then((result) => { if (active) setDonation(result); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not restore this donation.'); });
    return () => { active = false; };
  }, [api, authenticatedWallet, currentDonationId]);

  useEffect(() => {
    if (!authenticatedWallet || path !== '/collection') return;
    let active = true;
    void api<CollectionResponse>('/api/collection', {}, true)
      .then((result) => { if (active) setCollection(result); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load your collection.'); });
    return () => { active = false; };
  }, [api, authenticatedWallet, path, refreshVersion]);

  useEffect(() => {
    if (!authenticatedWallet || path !== '/history') return;
    let active = true;
    void api<{ donations: Donation[] }>('/api/history', {}, true)
      .then((result) => { if (active) setHistory(result.donations); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load your history.'); });
    return () => { active = false; };
  }, [api, authenticatedWallet, path, refreshVersion]);

  useEffect(() => {
    setPhotoEligibility(null);
    if (!donation || donation.status !== 'confirmed' || !authenticatedWallet) return;
    let active = true;
    void getPhotoEligibility(donation.id)
      .then((result) => { if (active) setPhotoEligibility(result); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load photo-sharing eligibility.');
      });
    return () => { active = false; };
  }, [authenticatedWallet, donation?.id, donation?.status, getPhotoEligibility]);

  useEffect(() => {
    if (!boardTempleId) {
      setBoardPhotos([]);
      setBoardError('');
      return;
    }
    let active = true;
    setBoardLoading(true);
    setBoardError('');
    void api<{ photos: PhotoDto[] }>(`/api/board/${encodeURIComponent(boardTempleId)}/photos`)
      .then((result) => { if (active) setBoardPhotos(result.photos); })
      .catch((cause: unknown) => {
        if (active) setBoardError(cause instanceof Error ? cause.message : 'Could not load this temple board.');
      })
      .finally(() => { if (active) setBoardLoading(false); });
    return () => { active = false; };
  }, [api, boardTempleId, refreshVersion]);

  useEffect(() => {
    if (!donation || !authenticatedWallet || !['submitting', 'unknown', 'submitted', 'confirmed'].includes(donation.status) || donation.mintStatus === 'minted') return;
    let active = true;
    let inFlight = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || inFlight || attempts >= POLL_LIMIT) return;
      inFlight = true;
      attempts += 1;
      try {
        const txHash = pendingOperation?.donationId === donation.id && pendingOperation.operation === 'donate'
          ? pendingOperation.txHash
          : donation.txHash;
        const latest = await api<Donation>(`/api/donations/${encodeURIComponent(donation.id)}/verify`, {
          method: 'POST',
          body: JSON.stringify(txHash ? { txHash } : {}),
        }, true);
        if (active) {
          setDonation(latest);
          if (['confirmed', 'failed', 'expired'].includes(latest.status) && pendingOperation?.donationId === latest.id && pendingOperation.operation === 'donate') {
            persistPending(null);
          }
        }
        if (active && latest.mintStatus !== 'minted' && ['submitting', 'unknown', 'submitted', 'confirmed'].includes(latest.status)) {
          timer = setTimeout(poll, 2500);
        }
      } catch {
        if (active && attempts < POLL_LIMIT) timer = setTimeout(poll, 2500);
      } finally {
        inFlight = false;
      }
    };
    timer = setTimeout(poll, 2500);
    return () => { active = false; clearTimeout(timer); };
  }, [api, authenticatedWallet, donation?.id, donation?.status, donation?.mintStatus, pendingOperation?.donationId, pendingOperation?.operation, refreshVersion]);

  const selectedTemple = useMemo(() => currentTemple, [currentTemple]);
  const chosenAmount = customAmount.trim() || amount;
  let amountUnits = 0n;
  let amountError = '';
  try {
    amountUnits = parseAmount(chosenAmount);
  } catch (cause) {
    amountError = cause instanceof Error ? cause.message : 'Enter a valid USDC amount.';
  }
  const feeUnits = amountUnits / 10000n;
  const netUnits = amountUnits - feeUnits;
  const matchingTemples = temples.filter((temple) => `${temple.name} ${temple.description}`.toLowerCase().includes(query.toLowerCase()));
  const walletReady = Boolean(address && isConnected && authenticatedWallet === address.toLowerCase());

  useEffect(() => {
    recordWalletTrace('wagmi-account', {
      connector: connector?.id,
      chainId,
      connected: isConnected,
      addressPresent: Boolean(address),
    });
  }, [address, chainId, connector?.id, isConnected]);

  const connectWallet = async () => {
    setError('');
    let injectedConnector: (typeof connectors)[number] | undefined;
    let attemptId: string | undefined;
    try {
      for (const candidate of connectors) {
        if ((candidate.id === 'injected' || /metamask/i.test(candidate.name)) && await candidate.getProvider()) {
          injectedConnector = candidate;
          break;
        }
      }
      if (injectedConnector) {
        attemptId = startWalletAttempt(injectedConnector.id);
        recordWalletTrace('provider-start', { connector: injectedConnector.id }, attemptId);
        const result = await connectAsync({ connector: injectedConnector });
        recordWalletTrace('provider-resolve', {
          connector: injectedConnector.id,
          chainId: result.chainId,
          connected: true,
          addressPresent: result.accounts.length > 0,
        }, attemptId);
      } else if (config.reownProjectId) {
        runtime.openWalletConnect();
      } else {
        setNotice('No injected wallet was detected and WalletConnect is not configured for this deployment.');
      }
    } catch (cause) {
      recordWalletTrace('provider-reject', { connector: injectedConnector?.id }, attemptId);
      setError(cause instanceof Error ? cause.message : 'Wallet connection was not completed.');
    }
  };

  const authenticateWallet = async () => {
    if (!address || !walletClient) throw new Error('Connect a wallet before continuing.');
    setConnectingAuth(true);
    try {
      if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID });
      const challenge = await api<{ nonce: string; message: string }>('/api/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({ wallet: address }),
      });
      const signature = await walletClient.signMessage({ account: address, message: challenge.message });
      const result = await api<{ customToken: string }>('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ nonce: challenge.nonce, signature }),
      });
      await signInWithCustomToken(auth, result.customToken);
      const wallet = address.toLowerCase();
      localStorage.setItem(AUTH_WALLET, wallet);
      setAuthenticatedWallet(wallet);
      setNotice('Wallet verified. Your private donation records are now available.');
    } finally {
      setConnectingAuth(false);
    }
  };

  const signInWallet = () => {
    if (connectingAuth) {
      setNotice('Wallet verification is already in progress. Complete or reject the existing wallet request.');
      return;
    }
    setError('');
    void authenticateWallet().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Wallet verification failed.');
    });
  };

  const persistPending = (next: PendingOperation | null) => {
    setPendingOperation(next);
    if (next) localStorage.setItem(PENDING_OPERATION, JSON.stringify(next));
    else localStorage.removeItem(PENDING_OPERATION);
  };

  const ensureNetwork = async () => {
    if (!address) throw new Error('Connect your wallet first.');
    if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID });
  };

  const createOperation = async (target: Donation, operation: 'approve' | 'donate') => {
    const attemptId = crypto.randomUUID();
    const next = { donationId: target.id, operation, attemptId } satisfies PendingOperation;
    persistPending(next);
    await api<Donation>(`/api/donations/${encodeURIComponent(target.id)}/operation`, {
      method: 'POST',
      body: JSON.stringify({ operation, attemptId }),
    }, true);
    return next;
  };

  const waitForReceipt = async (hash: Hex) => {
    if (!publicClient) throw new Error('Base Sepolia is not available yet.');
    return publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 45000 });
  };

  const verifyDonation = async (target: Donation, txHash?: Hex) => {
    const result = await api<Donation>(`/api/donations/${encodeURIComponent(target.id)}/verify`, {
      method: 'POST',
      body: JSON.stringify(txHash ? { txHash } : {}),
    }, true);
    setDonation(result);
    setRefreshVersion((version) => version + 1);
    if (result.mintStatus === 'minted' || ['confirmed', 'failed', 'expired'].includes(result.status)) {
      persistPending(null);
    }
    if (result.mintStatus === 'minted') {
      setNotice('Central verified your donation and the stamp was minted.');
    } else {
      setNotice('Transaction sent. Central is still checking the chain; no second payment will be sent.');
    }
  };

  const sendDonation = async (target: Donation) => {
    await ensureNetwork();
    const next = await createOperation(target, 'donate');
    try {
      const hash = await writeContractAsync({
        address: config.vault!,
        abi: vaultAbi,
        functionName: 'donate',
        args: [target.id, target.templeKey, target.kind, parseDonationUnits(target.amount), BigInt(target.deadline), target.signature],
        chainId: CHAIN_ID,
      });
      persistPending({ ...next, txHash: hash });
      setNotice('Transaction submitted. Waiting for the Base Sepolia receipt…');
      setDonation({ ...target, status: 'submitting', txHash: hash });
      const receipt = await waitForReceipt(hash);
      await verifyDonation(target, hash);
      if (receipt.status === 'reverted') setNotice('The wallet transaction reverted. Central is checking the final result.');
    } catch (cause) {
      if (isWalletRejection(cause)) {
        persistPending(null);
        setDonation({ ...target, status: 'intent' });
        setNotice('The wallet request was rejected before submission. No donation was sent.');
      } else {
        setDonation({ ...target, status: 'unknown' });
        setNotice('The result is not yet known. Check with Central before taking another action; KALASH will not resend automatically.');
        setError(cause instanceof Error ? cause.message : 'Transaction result is unknown.');
      }
    }
  };

  const startDonation = async () => {
    setError('');
    setNotice('');
    if (!selectedTemple) return;
    if (donation && (donation.status === 'unknown' || donation.status === 'submitting' || donation.status === 'submitted') && donation.mintStatus !== 'minted') {
      setError('This donation may already have reached the network. Check its status with Central before starting another payment.');
      return;
    }
    if (donation && pendingOperation?.donationId === donation.id) {
      setError('A wallet operation is still being resolved. Check that operation before starting another payment.');
      return;
    }
    if (!config.vault || !config.stamp) {
      setError('Donations are unavailable: the Central deployment has not configured the vault and stamp contracts.');
      return;
    }
    if (amountError) {
      setError(amountError);
      return;
    }
    if (!address || !isConnected) {
      setError('Connect your wallet before donating.');
      return;
    }
    setBusy(true);
    try {
      if (!walletReady) await authenticateWallet();
      await ensureNetwork();
      const reuseIntent = donation?.id === currentDonationId
        && donation.status === 'intent'
        && !pendingOperation
        && donation.templeId === selectedTemple.id
        && donation.amount === amountUnits.toString()
        && donation.deadline > Math.floor(Date.now() / 1000);
      const intent = reuseIntent ? donation : await api<Donation>('/api/donations', {
        method: 'POST',
        body: JSON.stringify({ templeId: selectedTemple.id, amount: chosenAmount }),
      }, true);
      setDonation(intent);
      setCurrentDonationId(intent.id);
      localStorage.setItem(CURRENT_DONATION, intent.id);
      persistPending(null);

      const required = parseDonationUnits(intent.amount);
      if (!publicClient || !address) throw new Error('Wallet or Base Sepolia connection is unavailable.');
      const allowance = await publicClient.readContract({
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, config.vault],
      });
      if (allowance < required) {
        const next = await createOperation(intent, 'approve');
        const hash = await writeContractAsync({
          address: config.usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [config.vault, required],
          chainId: CHAIN_ID,
        });
        persistPending({ ...next, txHash: hash });
        setNotice('Exact USDC allowance submitted. Waiting for its receipt before the donation step…');
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== 'success') throw new Error('USDC approval was reverted. No donation was sent.');
        persistPending(null);
      }
      await sendDonation(intent);
    } catch (cause) {
      if (isWalletRejection(cause)) {
        persistPending(null);
        if (donation) setDonation({ ...donation, status: 'intent' });
        setNotice('The wallet request was rejected before submission. No donation was sent.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Donation could not be started.');
      }
    } finally {
      setBusy(false);
    }
  };

  const checkCentral = async () => {
    if (!donation) return;
    setBusy(true);
    setError('');
    try {
      const hash = pendingOperation?.donationId === donation.id && pendingOperation.operation === 'donate'
        ? pendingOperation.txHash
        : donation.txHash;
      await verifyDonation(donation, hash);
      setRefreshVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check with Central.');
    } finally {
      setBusy(false);
    }
  };

  const restoreDonation = async () => {
    if (!currentDonationId) return;
    setBusy(true);
    setError('');
    try {
      const restored = await api<Donation>(`/api/donations/${encodeURIComponent(currentDonationId)}`, {}, true);
      setDonation(restored);
      setRefreshVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore your donation.');
    } finally {
      setBusy(false);
    }
  };

  const resumeAfterApproval = async () => {
    if (!pendingOperation?.txHash || pendingOperation.operation !== 'approve' || !donation || !publicClient) return;
    setBusy(true);
    setError('');
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: pendingOperation.txHash });
      if (receipt.status !== 'success') {
        persistPending(null);
        setError('The approval transaction reverted. No donation was sent; you may start again.');
        return;
      }
      persistPending(null);
      await sendDonation(donation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval is still pending. No donation was sent.');
    } finally {
      setBusy(false);
    }
  };

  const publishPhoto = async (donationId: Hex, file: File, displayName: string) => {
    const imageBase64 = await fileAsBase64(file);
    const result = await api<PhotoUploadResponse>('/api/photos', {
      method: 'POST',
      body: JSON.stringify({
        donationId,
        imageBase64,
        contentType: file.type,
        displayName,
        consent: true,
        consentVersion: PHOTO_CONSENT_VERSION,
      }),
    }, true);
    setNotice(result.cleanupPending
      ? 'Your new photo is public. Replaced image cleanup is queued and will retry.'
      : 'Your photo is now on the public temple board.');
    setRefreshVersion((version) => version + 1);
    return result;
  };

  const withdrawPhoto = async (photoId: string) => {
    try {
      const result = await api<{ cleanupPending: boolean }>(
        `/api/photos/${encodeURIComponent(photoId)}/withdraw`,
        { method: 'POST', body: '{}' },
        true,
      );
      setNotice(result.cleanupPending
        ? 'Your photo is no longer public. Image deletion is queued and will retry.'
        : 'Your photo was withdrawn and deleted.');
      setRefreshVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not withdraw this photo.');
    }
  };

  const signOutWallet = async () => {
    await signOut(auth);
    disconnect();
    localStorage.removeItem(AUTH_WALLET);
    localStorage.removeItem(CURRENT_DONATION);
    localStorage.removeItem(PENDING_OPERATION);
    setAuthenticatedWallet(null);
    setCurrentDonationId(null);
    setDonation(null);
    setPendingOperation(null);
    setCollection(null);
    setHistory([]);
    navigate('/temples');
  };

  const detailRoute = Boolean(currentTemple);
  const activeSection = path === '/collection' ? 'collection' : path === '/history' ? 'history' : 'explore';

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand-button" onClick={() => navigate('/temples')} aria-label="KALASH home">
          <span className="brand">KALASH<span className="brand-mark">✦</span></span>
          <span className="brand-subtitle">A pilgrim’s guide</span>
        </button>
        <div className="topbar-actions">
          {isConnected && address ? (
            <div className="wallet-chip">
              <span className={`connection-dot ${walletReady ? 'is-verified' : ''}`} />
              <span className="wallet-address">{address.slice(0, 6)}…{address.slice(-4)}</span>
              {walletReady
                ? <button className="text-button" onClick={() => void signOutWallet()}>Sign out</button>
                : <button className="button button-small button-outline" disabled={connectingAuth} onClick={signInWallet}>{connectingAuth ? 'Verifying…' : 'Verify wallet'}</button>}
            </div>
          ) : (
            <button className="button button-small button-outline" onClick={() => void connectWallet()} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </header>

      <main>
        {error && <div className="notice notice-danger" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="notice notice-info" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}

        {detailRoute && currentTemple ? (
          <TempleDetail
            temple={currentTemple}
            config={config}
            address={address}
            chainId={chainId}
            amount={amount}
            setAmount={(value) => { setCustomAmount(''); setAmount(value); }}
            customAmount={customAmount}
            setCustomAmount={(value) => { setCustomAmount(value); }}
            amountError={amountError}
            amountUnits={amountUnits}
            feeUnits={feeUnits}
            netUnits={netUnits}
            connected={isConnected}
            walletReady={walletReady}
            connectingAuth={connectingAuth}
            busy={busy}
            donation={donation}
            currentDonationId={currentDonationId}
            pendingOperation={pendingOperation}
            onConnect={() => void connectWallet()}
            onDonate={() => void startDonation()}
            onCheck={() => void checkCentral()}
            onResumeApproval={() => void resumeAfterApproval()}
            onRestore={() => void restoreDonation()}
            onCollection={() => { setRefreshVersion((version) => version + 1); navigate('/collection'); }}
            onExplore={() => navigate('/temples')}
            onBoard={() => navigate(`/board/${currentTemple.id}`)}
            openWalletConnect={runtime.openWalletConnect}
            hasWalletConnect={Boolean(config.reownProjectId)}
            photoEligibility={photoEligibility}
            onUploadPhoto={publishPhoto}
          />
        ) : path === '/collection' ? (
          <CollectionPage
            temples={temples}
            collection={collection}
            authenticated={walletReady}
            donations={collection?.donations ?? []}
            photos={collection?.photos ?? []}
            onConnect={() => void connectWallet()}
            onSignIn={signInWallet}
            onExplore={() => navigate('/temples')}
            onRefresh={() => setRefreshVersion((version) => version + 1)}
            onHistory={() => navigate('/history')}
            onResume={() => donation?.templeId && navigate(`/temples/${donation.templeId}`)}
            onWithdrawPhoto={withdrawPhoto}
            onBoard={(templeId) => navigate(`/board/${templeId}`)}
          />
        ) : boardTempleId ? (
          <PhotoBoardPage
            temple={temples.find((item) => item.id === boardTempleId)}
            photos={boardPhotos}
            loading={boardLoading}
            error={boardError}
            onExplore={() => navigate('/temples')}
          />
        ) : path === '/history' ? (
          <HistoryPage
            temples={temples}
            donations={history}
            authenticated={walletReady}
            onConnect={() => void connectWallet()}
            onSignIn={signInWallet}
            onExplore={() => navigate('/temples')}
            onPhotoEligibility={getPhotoEligibility}
            onUploadPhoto={publishPhoto}
          />
        ) : (
          <ExplorePage temples={matchingTemples} query={query} setQuery={setQuery} view={exploreView} setView={setExploreView} onTemple={(temple) => navigate(`/temples/${temple.id}`)} />
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main navigation">
        <button className={activeSection === 'explore' ? 'active' : ''} onClick={() => navigate('/temples')}><span aria-hidden="true">⌂</span>Explore</button>
        <button className={activeSection === 'collection' ? 'active' : ''} onClick={() => navigate('/collection')}><span aria-hidden="true">✦</span>Collection</button>
        <button onClick={() => setNotice('QR scanning is not available in this release. Open a temple detail page to explore remote support.') }><span aria-hidden="true">▦</span>Scan QR</button>
        <button className={activeSection === 'history' ? 'active' : ''} onClick={() => navigate('/history')}><span aria-hidden="true">◷</span>History</button>
      </nav>
    </div>
  );
}

function ExplorePage({ temples, query, setQuery, view, setView, onTemple }: { temples: Temple[]; query: string; setQuery: (value: string) => void; view: 'map' | 'list'; setView: (view: 'map' | 'list') => void; onTemple: (temple: Temple) => void }) {
  return (
    <section className="page explore-page">
      <div className="eyebrow">A GENTLER WAY TO GIVE</div>
      <div className="page-heading-row">
        <div>
          <h1>Find a place to begin</h1>
          <p className="lede">Explore welcoming community temples and support the work that happens there.</p>
        </div>
        <span className="demo-badge">Illustrative demo catalog</span>
      </div>
      <label className="search-field">
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search temples" aria-label="Search temples" />
      </label>
      <div className="explore-toolbar">
        <p className="catalog-note">Ten fictional demo points near Jio World Convention Centre · no temple affiliation.</p>
        <div className="view-switch" role="tablist" aria-label="Temple view">
          <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'selected' : ''} onClick={() => setView('map')}>Map</button>
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}>List</button>
        </div>
      </div>
      {view === 'map' && <MapTiles temples={temples} onTemple={onTemple} />}
      {view === 'map' && (
        <div className="map-temple-list">
          {temples.map((temple, index) => <button key={temple.id} onClick={() => onTemple(temple)}><span>{index + 1}</span>{temple.name}<i>›</i></button>)}
        </div>
      )}
      {temples.length ? (
        view === 'list' ? <div className="temple-list">
          {temples.map((temple, index) => (
            <button className="temple-list-card" key={temple.id} onClick={() => onTemple(temple)}>
              <Illustration motif={temple.motif} className="list-art" />
              <span className="temple-list-copy">
                <span className="temple-order">TEMPLE {String(index + 1).padStart(2, '0')}</span>
                <strong>{temple.name}</strong>
                <span className="temple-description">{temple.description}</span>
                <span className="temple-tags"><span>Remote support</span>{temple.onsite && <span>On-site visits</span>}</span>
              </span>
              <span className="list-chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </div> : null
      ) : <div className="empty-state"><span className="empty-icon">⌕</span><h2>No temples found</h2><p>Try a different search.</p></div>}
    </section>
  );
}

function TempleDetail(props: {
  temple: Temple;
  config: Runtime['config'];
  address?: Address;
  chainId?: number;
  amount: string;
  setAmount: (value: string) => void;
  customAmount: string;
  setCustomAmount: (value: string) => void;
  amountError: string;
  amountUnits: bigint;
  feeUnits: bigint;
  netUnits: bigint;
  connected: boolean;
  walletReady: boolean;
  connectingAuth: boolean;
  busy: boolean;
  donation: Donation | null;
  currentDonationId: Hex | null;
  pendingOperation: PendingOperation | null;
  onConnect: () => void;
  onDonate: () => void;
  onCheck: () => void;
  onResumeApproval: () => void;
  onRestore: () => void;
  onCollection: () => void;
  onExplore: () => void;
  onBoard: () => void;
  openWalletConnect: () => void;
  hasWalletConnect: boolean;
  photoEligibility: PhotoEligibility | null;
  onUploadPhoto: (donationId: Hex, file: File, displayName: string) => Promise<PhotoUploadResponse>;
}) {
  const { temple, config } = props;
  const ready = Boolean(config.vault && config.stamp);
  return (
    <section className="page detail-page">
      <button className="back-link" onClick={props.onExplore}><span aria-hidden="true">←</span> All temples</button>
      <div className="detail-grid">
        <div className="detail-main">
          <Illustration motif={temple.motif} className="detail-art" />
          <div className="detail-title">
            <span className="eyebrow">AN OPEN INVITATION</span>
            <h1>{temple.name}</h1>
            <p className="lede">{temple.description}</p>
          </div>
          <div className="detail-info-grid">
            <article className="info-card">
              <span className="info-icon">✿</span><div><h2>A place to pause</h2><p>This is one of ten illustrative demo temples created for the KALASH test experience.</p></div>
            </article>
            <article className="info-card">
              <span className="info-icon">◎</span><div><h2>Illustrative area</h2><p>This fictional demo point is near Jio World Convention Centre; no real temple or affiliation is implied.</p><a className="outbound-link" href={`https://www.openstreetmap.org/?mlat=${MAP_VENUE.latitude}&mlon=${MAP_VENUE.longitude}#map=16/${MAP_VENUE.latitude}/${MAP_VENUE.longitude}`} target="_blank" rel="noreferrer">View venue area on OpenStreetMap ↗</a></div>
            </article>
          </div>
          <div className="support-note">
            <span aria-hidden="true">✦</span><div><strong>Make your support count</strong><p>A successful remote donation can earn a real on-chain KALASH stamp after Central verifies it.</p></div>
          </div>
          <button className="text-button board-link" onClick={props.onBoard}>View community photo board</button>
        </div>
        <aside className="donation-card">
          <div className="donation-card-heading"><span className="eyebrow">REMOTE SUPPORT</span><h2>Send a small offering</h2><p>Choose an amount in test USDC.</p></div>
          <div className="amount-options" role="group" aria-label="Donation amount">
            {AMOUNTS.map((option) => (
              <button className={props.amount === option && !props.customAmount ? 'selected' : ''} key={option} onClick={() => props.setAmount(option)}>{option}<small>USDC</small></button>
            ))}
          </div>
          <label className="field-label" htmlFor="custom-amount">Or enter another amount</label>
          <div className={`currency-input ${props.amountError && props.customAmount ? 'input-error' : ''}`}>
            <span>$</span><input id="custom-amount" inputMode="decimal" value={props.customAmount} onChange={(event) => props.setCustomAmount(event.target.value)} placeholder="0.01" aria-describedby="amount-help" /><span className="currency-code">USDC</span>
          </div>
          <p className="field-help" id="amount-help">Minimum $0.000001 · maximum 1 USDC · up to 6 decimals.</p>
          {props.amountError && props.customAmount && <p className="inline-error">{props.amountError}</p>}
          <div className="amount-summary">
            <div><span>Your donation</span><strong>{formatUsdc(props.amountUnits)} USDC</strong></div>
            <div><span>Central fee <small>0.01%</small></span><span>{formatUsdc(props.feeUnits)} USDC</span></div>
            <div className="summary-total"><span>Temple receives</span><strong>{formatUsdc(props.netUnits)} USDC</strong></div>
            <p>Base Sepolia test network · estimate ₹100 per USDC.</p>
          </div>
          <p className="inr-estimate">Estimated value <strong>{formatInr(props.amountUnits)}</strong></p>
          {props.connected && props.chainId !== CHAIN_ID && <div className="inline-warning">Switch to Base Sepolia in your wallet before donating.</div>}
          {!ready && <div className="inline-warning">Donations are unavailable until Central deploys the vault and stamp contracts.</div>}
          {!props.connected ? (
            <div className="connect-stack">
              <button className="button button-primary button-wide" onClick={props.onConnect}>Connect MetaMask</button>
              {props.hasWalletConnect
                ? <button className="button button-secondary button-wide" onClick={props.openWalletConnect}>Connect another wallet</button>
                : <p className="field-help">WalletConnect is not configured; an injected wallet can still connect.</p>}
            </div>
          ) : !props.walletReady ? (
            <button className="button button-primary button-wide" onClick={props.onDonate} disabled={!ready || props.busy || props.connectingAuth}>
              {props.connectingAuth ? 'Verify in your wallet…' : 'Verify wallet & continue'}
            </button>
          ) : (
            <button
              className="button button-primary button-wide"
              onClick={props.onDonate}
              disabled={!ready || props.busy || Boolean(props.amountError) || Boolean(props.currentDonationId && !props.donation) || Boolean(props.donation && ['unknown', 'submitting', 'submitted'].includes(props.donation.status) && props.donation.mintStatus !== 'minted') || Boolean(props.donation && props.pendingOperation?.donationId === props.donation.id)}
            >
              {props.busy ? 'Please wait…' : props.currentDonationId && !props.donation ? 'Restoring donation…' : `Donate ${formatUsdc(props.amountUnits)} USDC`}
            </button>
          )}
          <p className="disclosure">Before you continue: your wallet address, temple, day and transaction details are public on-chain. Test USDC has no real value; wallet network fees may apply.</p>

          {props.pendingOperation?.operation === 'approve' && (
            <div className="pending-box">
              <strong>USDC approval is not confirmed</strong>
              <p>No donation has been sent yet. Check the approval in your wallet, then continue only after it succeeds.</p>
              {props.pendingOperation.txHash && <button className="button button-secondary button-wide" onClick={props.onResumeApproval} disabled={props.busy}>Check approval & continue</button>}
            </div>
          )}
          {props.donation && (
            <DonationProgress
              donation={props.donation}
              pendingOperation={props.pendingOperation}
              busy={props.busy}
              onCheck={props.onCheck}
              onRestore={props.onRestore}
              onCollection={props.onCollection}
              photoEligibility={props.photoEligibility}
              onUploadPhoto={props.onUploadPhoto}
            />
          )}
        </aside>
      </div>
    </section>
  );
}

function DonationProgress({ donation, pendingOperation, busy, onCheck, onRestore, onCollection, photoEligibility, onUploadPhoto }: {
  donation: Donation;
  pendingOperation: PendingOperation | null;
  busy: boolean;
  onCheck: () => void;
  onRestore: () => void;
  onCollection: () => void;
  photoEligibility: PhotoEligibility | null;
  onUploadPhoto: (donationId: Hex, file: File, displayName: string) => Promise<PhotoUploadResponse>;
}) {
  const minted = donation.mintStatus === 'minted';
  const unknown = donation.status === 'unknown' || donation.status === 'submitting' || (pendingOperation?.donationId === donation.id && !pendingOperation.txHash);
  return (
    <div className={`donation-progress ${minted ? 'is-minted' : ''}`}>
      <div className={`status-pill ${statusTone(donation.status, donation.mintStatus)}`}><span className="status-dot" />{donationStatusLabel(donation.status, donation.mintStatus)}</div>
      <ul className="progress-steps">
        <li className={donation.status !== 'intent' ? 'complete' : 'current'}><span>1</span><div><strong>Wallet transaction</strong><small>{unknown ? 'Result unknown · check before taking another action' : donation.txHash ? `${donation.txHash.slice(0, 10)}…` : 'Not submitted'}</small></div></li>
        <li className={donation.status === 'confirmed' || minted ? 'complete' : donation.status === 'submitted' ? 'current' : ''}><span>2</span><div><strong>Central verification</strong><small>{donation.status === 'confirmed' || minted ? 'Verified on Base Sepolia' : 'Waiting for Central'}</small></div></li>
        <li className={minted ? 'complete' : donation.status === 'confirmed' ? 'current' : ''}><span>3</span><div><strong>Temple stamp</strong><small>{minted ? 'Minted on-chain' : donation.status === 'confirmed' ? 'Mint is pending' : 'Issued after verification'}</small></div></li>
      </ul>
      {unknown && <p className="field-help">An uncertain wallet result is never resent automatically. Use “Check with Central” first.</p>}
      {(donation.status !== 'intent' || pendingOperation?.donationId === donation.id) && !minted && (
        <button className="button button-secondary button-wide" onClick={onCheck} disabled={busy}>
          {busy ? 'Checking…' : 'Check with Central'}
        </button>
      )}
      {donation.status === 'confirmed' && (
        <PhotoSharePanel
          key={donation.id}
          donationId={donation.id}
          eligibility={photoEligibility}
          onUpload={onUploadPhoto}
        />
      )}
      {donation.status === 'intent' && !pendingOperation && (
        <button className="button button-secondary button-wide" onClick={onRestore} disabled={busy}>Restore donation status</button>
      )}
      {minted && (
        <div className="minted-next">
          <p>Sharing a photo is optional and does not affect your stamp.</p>
          <button className="button button-primary button-wide" onClick={onCollection}>Skip photo · View collection</button>
        </div>
      )}
    </div>
  );
}

function PhotoFrame({ photo }: { photo: PhotoDto }) {
  const width = PHOTO_SIZE_TIERS.find((entry) => entry.tier === photo.sizeTier)?.displayWidth ?? 88;
  return (
    <figure className="photo-frame" style={{ width }}>
      <div className="photo-ornament" aria-hidden="true">✿ ✦ ✿</div>
      <img src={photo.imageUrl} alt="Pilgrim photo shared with consent" loading="lazy" />
      <figcaption>{photo.displayName || 'A fellow pilgrim'}</figcaption>
    </figure>
  );
}

function PhotoSharePanel({ donationId, eligibility, onUpload }: {
  donationId: Hex;
  eligibility: PhotoEligibility | null;
  onUpload: (donationId: Hex, file: File, displayName: string) => Promise<PhotoUploadResponse>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [consent, setConsent] = useState(false);
  const [published, setPublished] = useState<PhotoDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    void video.play().catch(() => setError('Camera preview could not start. Close it or choose an image instead.'));
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [cameraStream]);

  useEffect(() => () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraStream(null);
  };

  const startCamera = async () => {
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is unavailable in this browser. Choose an image instead.');
      return;
    }
    setCameraBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      cameraStreamRef.current = stream;
      setCameraStream(stream);
    } catch (cause) {
      const reason = cause instanceof DOMException && cause.name === 'NotAllowedError'
        ? 'Camera permission was denied.'
        : cause instanceof DOMException && cause.name === 'NotFoundError'
          ? 'No camera was found.'
          : 'Camera could not be opened.';
      setError(`${reason} You can still choose an image from your device.`);
    } finally {
      setCameraBusy(false);
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setError('The camera is still starting. Try again in a moment.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setError('Could not prepare the camera image. Choose a file instead.');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) {
      setError('Could not capture the camera image. Try again or choose a file.');
      return;
    }
    stopCamera();
    selectImage(new File([blob], `kalash-photo-${Date.now()}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    }));
  };

  const selectImage = (selected: File | undefined) => {
    setError('');
    setPublished(null);
    setConsent(false);
    if (!selected) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) {
      setFile(null);
      setError('Choose a JPEG, PNG or WebP image.');
      return;
    }
    if (selected.size > 5 * 1024 * 1024) {
      setFile(null);
      setError('Image must be no larger than 5 MB.');
      return;
    }
    setFile(selected);
  };

  const share = async () => {
    if (!file || !consent || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await onUpload(donationId, file, displayName);
      setPublished(result.photo);
      setFile(null);
      setConsent(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Photo upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="photo-share">
      <div className="section-title-row">
        <div><h3>Share a photo</h3><p>Optional · based on your verified support</p></div>
        {eligibility && <span className="photo-tier-label">Size {eligibility.sizeTier} of 4</span>}
      </div>
      {!eligibility ? <p className="field-help">Checking your verified photo size…</p> : (
        <>
          {published && <div className="published-photo"><PhotoFrame photo={published} /><a className="button button-outline" href={`/board/${encodeURIComponent(published.templeId)}`}>View community board</a></div>}
          {previewUrl && <div className="photo-preview">
            <span className="field-label">Preview · only you can see this until you agree to publish</span>
            <PhotoFrame photo={{
              id: 'preview', templeId: eligibility.templeId, displayName: displayName.trim() || null,
              sizeTier: eligibility.sizeTier, imageUrl: previewUrl, createdAt: '', expiresAt: '',
            }} />
          </div>}
          {cameraStream && <div className="camera-preview-stage">
            <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" />
            <div className="camera-actions">
              <button className="button button-primary" onClick={() => void capturePhoto()}>Take photo</button>
              <button className="button button-outline" onClick={stopCamera}>Close camera</button>
            </div>
          </div>}
          <div className="photo-file-actions">
            {!cameraStream && <button className="button button-secondary" onClick={() => void startCamera()} disabled={cameraBusy}>{cameraBusy ? 'Opening camera…' : 'Take a photo'}</button>}
            <label className="button button-outline">Choose image<input className="photo-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectImage(event.currentTarget.files?.[0])} /></label>
            {file && <button className="text-button" onClick={() => { setFile(null); setConsent(false); }}>Discard</button>}
          </div>
          {file && (
            <>
              <label className="field-label" htmlFor="photo-display-name">Display name (optional)</label>
              <input id="photo-display-name" className="photo-name-input" maxLength={32} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="How should we name you?" />
              <label className="photo-consent">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>I agree to publish this photo and optional name on the public temple board for up to 30 days. Others may save copies. I can withdraw it later.</span>
              </label>
              <button className="button button-primary button-wide" onClick={() => void share()} disabled={!consent || busy}>{busy ? 'Preparing and publishing…' : 'Publish photo'}</button>
            </>
          )}
        </>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

function CollectionPage(props: {
  temples: Temple[];
  collection: CollectionResponse | null;
  donations: Donation[];
  photos: PhotoDto[];
  authenticated: boolean;
  onConnect: () => void;
  onSignIn: () => void;
  onExplore: () => void;
  onRefresh: () => void;
  onHistory: () => void;
  onResume: () => void;
  onWithdrawPhoto: (id: string) => Promise<void>;
  onBoard: (templeId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<'stamps' | 'photos'>('stamps');
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    const counted = new Set<string>();
    for (const donation of props.donations) {
      if (donation.mintStatus === 'minted' && donation.kind === 0 && !counted.has(donation.id)) {
        counted.add(donation.id);
        map.set(donation.templeId, (map.get(donation.templeId) ?? 0) + 1);
      }
    }
    return map;
  }, [props.donations]);
  const pending = [...new Map(props.donations
    .filter((item) => item.mintStatus !== 'minted' && item.status !== 'failed' && item.status !== 'expired')
    .map((item) => [item.id, item])).values()];
  return (
    <section className="page collection-page">
      <div className="eyebrow">YOUR PILGRIM JOURNEY</div>
      <div className="page-heading-row">
        <div><h1>Your collection</h1><p className="lede">Real stamps appear here after Central verifies and mints them.</p></div>
        {props.authenticated && <button className="button button-outline" onClick={props.onRefresh}>Refresh</button>}
      </div>
      {!props.authenticated ? (
        <div className="auth-prompt">
          <span className="auth-icon">✦</span><h2>Connect to see your collection</h2><p>Your stamps and donation history are private to your verified wallet.</p>
          <button className="button button-primary" onClick={props.onConnect}>Connect wallet</button>
          <button className="text-button" onClick={props.onSignIn}>I’m connected · verify wallet</button>
        </div>
      ) : (
        <>
          <div className="collection-tabs" role="tablist" aria-label="Collection">
            <button role="tab" aria-selected={activeTab === 'stamps'} className={activeTab === 'stamps' ? 'tab-active' : ''} onClick={() => setActiveTab('stamps')}>Stamps</button>
            <button role="tab" aria-selected={activeTab === 'photos'} className={activeTab === 'photos' ? 'tab-active' : ''} onClick={() => setActiveTab('photos')}>Photos</button>
          </div>
          {activeTab === 'photos' && <p className="photo-library-note">Your shared photos are managed here. To browse community photos, open a temple and choose “View community photo board”.</p>}
          {activeTab === 'stamps' ? (
            <>
              <StampBook title="Remote support" subtitle="A stamp for every successful online donation" temples={props.temples} counts={counts} emptyLabel="No remote stamps yet" />
              <StampBook title="On-site visits" subtitle="Earned during an in-person visit" temples={props.temples} counts={new Map()} onsiteOnly emptyLabel="On-site stamps will appear after a verified visit" />
              {pending.length > 0 && (
                <section className="pending-section">
                  <div className="section-title-row"><div><h2>Still in progress</h2><p>These are not counted as stamps.</p></div><button className="text-button" onClick={props.onResume}>Resume current donation</button></div>
                  <div className="pending-list">{pending.map((item) => <PendingDonation key={item.id} donation={item} temples={props.temples} />)}</div>
                </section>
              )}
            </>
          ) : props.photos.length ? (
            <div className="photo-gallery">
              {props.photos.map((photo) => (
                <article className="photo-gallery-card" key={photo.id}>
                  <PhotoFrame photo={photo} />
                  <div className="photo-gallery-copy">
                    <strong>{props.temples.find((item) => item.id === photo.templeId)?.name ?? 'Temple board'}</strong>
                    <span>Public until {new Date(photo.expiresAt).toLocaleDateString()}</span>
                    <button className="button button-outline" onClick={() => {
                      if (window.confirm('Withdraw this photo from the public board and delete it?')) {
                        void props.onWithdrawPhoto(photo.id);
                      }
                    }}>Withdraw photo</button>
                    <button className="text-button" onClick={() => props.onBoard(photo.templeId)}>View temple board</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state"><span className="empty-icon">✿</span><h2>No shared photos</h2><p>After a confirmed donation, you can preview a photo, consent to share it, and withdraw it here.</p></div>
          )}
          <div className="collection-footer-actions"><button className="button button-secondary" onClick={props.onExplore}>Explore temples</button><button className="button button-outline" onClick={props.onHistory}>View donation history</button></div>
        </>
      )}
    </section>
  );
}

function PhotoBoardPage({ temple, photos, loading, error, onExplore }: {
  temple: Temple | undefined;
  photos: PhotoDto[];
  loading: boolean;
  error: string;
  onExplore: () => void;
}) {
  return (
    <section className="page photo-board-page">
      <button className="back-link" onClick={onExplore}><span aria-hidden="true">←</span> All temples</button>
      <div className="eyebrow">COMMUNITY PHOTO BOARD</div>
      <h1>{temple?.name ?? 'Temple board'}</h1>
      <p className="lede">Photos shared with consent by pilgrims. Images are removed after 30 days or sooner if withdrawn.</p>
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      {loading ? <p className="field-help">Loading the photo board…</p> : photos.length ? (
        <div className="board-photo-grid">
          {photos.map((photo) => (
            <article className={`board-photo-card size-tier-${photo.sizeTier}`} key={photo.id}>
              <PhotoFrame photo={photo} />
            </article>
          ))}
        </div>
      ) : !error ? (
        <div className="empty-state"><span className="empty-icon">✿</span><h2>No shared photos yet</h2><p>When pilgrims choose to share, their photos will appear here.</p></div>
      ) : null}
    </section>
  );
}

function StampBook({ title, subtitle, temples, counts, onsiteOnly = false, emptyLabel }: {
  title: string;
  subtitle: string;
  temples: Temple[];
  counts: Map<string, number>;
  onsiteOnly?: boolean;
  emptyLabel: string;
}) {
  const slots = Array.from({ length: 10 }, (_, index) => {
    const id = `temple-${String(index + 1).padStart(2, '0')}`;
    return temples.find((temple) => temple.id === id);
  });
  return (
    <section className="stamp-book">
      <div className="section-title-row"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="book-total">{slots.length} temples</span></div>
      {onsiteOnly && <p className="book-empty-note">{emptyLabel}</p>}
      <div className="stamp-grid">
        {slots.map((temple, index) => {
          const count = temple ? counts.get(temple.id) ?? 0 : 0;
          return (
            <article className={`stamp-slot ${count ? 'has-stamp' : ''} ${onsiteOnly && temple && !temple.onsite ? 'not-available' : ''}`} key={temple?.id ?? `slot-${index}`}>
              <div className="stamp-circle">
                {temple ? <Illustration motif={temple.motif} className="stamp-art" /> : <span className="stamp-lock" aria-label="On-site collection slot">✧</span>}
                {count > 0 && <span className="stamp-check" aria-label="Collected">✓</span>}
              </div>
              <strong>{temple?.name ?? 'Coming soon'}</strong>
              <span>{onsiteOnly && temple && !temple.onsite ? 'Not available' : `Collected ${count} ${count === 1 ? 'time' : 'times'}`}</span>
            </article>
          );
        })}
      </div>
      {!counts.size && !onsiteOnly && <p className="book-empty-note">{emptyLabel}</p>}
    </section>
  );
}

function PendingDonation({ donation, temples }: { donation: Donation; temples: Temple[] }) {
  const temple = temples.find((entry) => entry.id === donation.templeId);
  return (
    <article className="pending-donation">
      <div className={`pending-state-icon ${statusTone(donation.status, donation.mintStatus)}`}>◷</div>
      <div className="pending-copy"><strong>{temple?.name ?? 'Temple support'}</strong><span>{formatUsdc(donation.amount)} USDC · {donationStatusLabel(donation.status, donation.mintStatus)}</span></div>
      <span className="pending-tag">Not counted</span>
    </article>
  );
}

function HistoryPage(props: {
  temples: Temple[];
  donations: Donation[];
  authenticated: boolean;
  onConnect: () => void;
  onSignIn: () => void;
  onExplore: () => void;
  onPhotoEligibility: (donationId: Hex) => Promise<PhotoEligibility>;
  onUploadPhoto: (donationId: Hex, file: File, displayName: string) => Promise<PhotoUploadResponse>;
}) {
  const templeNames = useMemo(() => new Map(props.temples.map((temple) => [temple.id, temple.name])), [props.temples]);
  const byMonth = useMemo(() => {
    const groups = new Map<string, Donation[]>();
    for (const item of [...props.donations].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const date = new Date(item.createdAt);
      const label = Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString('en', { month: 'long', year: 'numeric' });
      groups.set(label, [...(groups.get(label) ?? []), item]);
    }
    return [...groups];
  }, [props.donations]);
  return (
    <section className="page history-page">
      <div className="eyebrow">YOUR ACTIVITY</div><h1>Donation history</h1><p className="lede">A private record of your real donation attempts and outcomes.</p>
      {!props.authenticated ? (
        <div className="auth-prompt"><span className="auth-icon">◷</span><h2>Sign in to see your history</h2><p>Only your verified wallet can read these records.</p><button className="button button-primary" onClick={props.onConnect}>Connect wallet</button><button className="text-button" onClick={props.onSignIn}>I’m connected · verify wallet</button></div>
      ) : props.donations.length === 0 ? (
        <div className="empty-state"><span className="empty-icon">◷</span><h2>No donations yet</h2><p>Your real transaction history will show here.</p><button className="button button-secondary" onClick={props.onExplore}>Explore temples</button></div>
      ) : (
        <div className="history-timeline">
          {byMonth.map(([month, items]) => (
            <section key={month} className="history-month">
              <h2>{month}</h2>
              <div className="history-items">
                {items.map((item) => (
                  <article className="history-item" key={item.id}>
                    <span className="history-dot" />
                    <div className="history-details">
                      <strong>{templeNames.get(item.templeId) ?? 'Temple support'}</strong>
                      <span>{new Date(item.createdAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })} · Remote support</span>
                      <span className={`status-pill ${statusTone(item.status, item.mintStatus)}`}><span className="status-dot" />{donationStatusLabel(item.status, item.mintStatus)}</span>
                      {item.status === 'confirmed' && (
                        <HistoryPhotoShare
                          donationId={item.id}
                          onPhotoEligibility={props.onPhotoEligibility}
                          onUploadPhoto={props.onUploadPhoto}
                        />
                      )}
                    </div>
                    <strong className="history-amount">{formatUsdc(item.amount)}<small>USDC</small></strong>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryPhotoShare({ donationId, onPhotoEligibility, onUploadPhoto }: {
  donationId: Hex;
  onPhotoEligibility: (donationId: Hex) => Promise<PhotoEligibility>;
  onUploadPhoto: (donationId: Hex, file: File, displayName: string) => Promise<PhotoUploadResponse>;
}) {
  const [eligibility, setEligibility] = useState<PhotoEligibility | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void onPhotoEligibility(donationId)
      .then((result) => { if (active) setEligibility(result); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Photo sharing is unavailable.'); });
    return () => { active = false; };
  }, [donationId, onPhotoEligibility]);
  return (
    <div className="history-photo-action">
      {error ? <span className="field-help">{error}</span> : eligibility && (
        <PhotoSharePanel donationId={donationId} eligibility={eligibility} onUpload={onUploadPhoto} />
      )}
    </div>
  );
}
