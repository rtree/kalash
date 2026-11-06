export const BASE_SEPOLIA = 84532;
export const CONTROL_TARGET = 'https://kalash-central-548318651344.asia-south1.run.app/temples/temple-01';

export function phoneTarget(currentHref) {
  const url = new URL(currentHref);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === '[::1]' || host === '0.0.0.0' || /^127\./u.test(host)) {
    throw new Error('PUBLIC_HTTPS_REQUIRED');
  }
  // Only public test markers are forwarded; arbitrary query/hash values are not.
  url.search = '';
  url.hash = '';
  url.searchParams.set('mode', 'phone');
  url.searchParams.set('case', 'external-qr');
  return url.href;
}

export function targetFor(currentHref, choice) {
  if (choice === 'isolated') return phoneTarget(currentHref);
  if (choice === 'control') return CONTROL_TARGET;
  throw new Error('TARGET_NOT_ALLOWED');
}

export function isAllowedTarget(target, currentHref) {
  if (target === CONTROL_TARGET) return true;
  try {
    return target === phoneTarget(currentHref);
  } catch {
    return false;
  }
}

export function buildDeepLink(target, currentHref) {
  if (!isAllowedTarget(target, currentHref)) throw new Error('TARGET_NOT_ALLOWED');
  // Preserve the destination's escaped path and query; do not encode the whole URL.
  return `https://link.metamask.io/dapp/${target.slice('https://'.length)}`;
}

export function arrivalInfo(currentHref) {
  const url = new URL(currentHref);
  return {
    phone: url.searchParams.get('mode') === 'phone',
    testCase: url.searchParams.get('case') === 'external-qr' ? 'external-qr' : '未指定 / 未対応',
    origin: url.origin,
    path: url.pathname,
  };
}

const conflictingFlags = [
  'isCoinbaseWallet', 'isBraveWallet', 'isRabby', 'isPhantom',
  'isTrust', 'isTrustWallet', 'isOKExWallet', 'isOkxWallet',
];

export function isMetaMaskCandidate(provider) {
  try {
    return Boolean(provider && typeof provider.request === 'function' &&
      provider.isMetaMask === true && !conflictingFlags.some((flag) => provider[flag] === true));
  } catch {
    return false;
  }
}

export function providerCandidates(announcements, ethereum) {
  const conflicts = new Set(announcements
    .filter((entry) => entry?.info?.rdns !== 'io.metamask')
    .map((entry) => entry?.provider));
  const announced = announcements.filter((entry) =>
    entry?.info?.rdns === 'io.metamask' && isMetaMaskCandidate(entry.provider) &&
    !conflicts.has(entry.provider));
  const unique = (providers) => [...new Set(providers)];
  if (announced.length) {
    return unique(announced.map((entry) => entry.provider))
      .map((provider) => ({ provider, source: 'EIP-6963' }));
  }
  let injected = [];
  try {
    injected = Array.isArray(ethereum?.providers) ? ethereum.providers : [ethereum];
  } catch {
    return [];
  }
  return unique(injected).filter((provider) =>
    isMetaMaskCandidate(provider) && !conflicts.has(provider))
    .map((provider) => ({ provider, source: 'legacy injection' }));
}

export function createDiscovery({ target, getEthereum, onChange }) {
  const announcements = [];
  let listening = false;
  const emit = () => onChange(providerCandidates(announcements, getEthereum()));
  const announce = (event) => {
    const detail = event.detail;
    if (!detail?.provider || typeof detail?.info?.rdns !== 'string') return;
    if (!announcements.some((entry) =>
      entry.provider === detail.provider && entry.info.rdns === detail.info.rdns)) {
      announcements.push({ provider: detail.provider, info: { rdns: detail.info.rdns } });
    }
    emit();
  };
  const refresh = () => {
    if (!listening) return;
    target.dispatchEvent(new (target.Event ?? Event)('eip6963:requestProvider'));
    emit();
  };
  return {
    start() {
      if (listening) return;
      listening = true;
      target.addEventListener('eip6963:announceProvider', announce);
      target.addEventListener('ethereum#initialized', refresh);
      refresh();
    },
    refresh,
    stop() {
      listening = false;
      target.removeEventListener('eip6963:announceProvider', announce);
      target.removeEventListener('ethereum#initialized', refresh);
      announcements.length = 0;
    },
  };
}

export function parseChainId(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function accountCount(value) {
  return Array.isArray(value) &&
    value.every((account) => typeof account === 'string' && /^0x[0-9a-f]{40}$/iu.test(account))
    ? value.length : null;
}

export function createWalletProbe(onChange) {
  let provider = null;
  let generation = 0;
  let accountRevision = 0;
  let chainRevision = 0;
  let requested = false;
  let removeEvents = () => {};
  let state = { status: 'unselected', pending: false, accountCount: null, chainId: null };
  const publish = (patch) => {
    state = { ...state, ...patch };
    onChange({ ...state });
  };
  const observedStatus = () => state.accountCount === 0 ? 'disconnected'
    : state.accountCount > 0 && state.chainId !== null ? 'connected' : 'incomplete';
  return {
    get state() { return { ...state }; },
    select(next) {
      generation++;
      requested = false;
      removeEvents();
      removeEvents = () => {};
      provider = next;
      publish({ status: next ? 'ready' : 'unselected', accountCount: null, chainId: null });
      if (!next) return;
      if (typeof next.on !== 'function' || typeof next.removeListener !== 'function') {
        publish({ status: 'unsupported' });
        return;
      }
      const accountsChanged = (accounts) => {
        if (!requested || provider !== next) return;
        accountRevision++;
        const count = accountCount(accounts);
        publish({ accountCount: count, ...(count === 0 || count === null ? { chainId: null } : {}) });
        publish({ status: count === null ? 'error' : observedStatus() });
      };
      const chainChanged = (chain) => {
        if (!requested || provider !== next) return;
        chainRevision++;
        publish({ chainId: parseChainId(chain) });
        publish({ status: state.chainId === null ? 'error' : observedStatus() });
      };
      const disconnect = () => {
        if (provider !== next) return;
        generation++;
        requested = false;
        publish({ status: 'disconnected', accountCount: 0, chainId: null });
      };
      const events = { accountsChanged, chainChanged, disconnect };
      removeEvents = () => {
        for (const [name, listener] of Object.entries(events)) {
          try {
            next.removeListener(name, listener);
          } catch {
            console.warn('UX mobile: provider listener cleanup failed; stale events are ignored.');
          }
        }
      };
      try {
        for (const [name, listener] of Object.entries(events)) next.on(name, listener);
      } catch {
        removeEvents();
        publish({ status: 'unsupported' });
      }
    },
    async connect() {
      if (!provider || state.pending || state.status === 'unsupported') return false;
      const selected = provider;
      const token = ++generation;
      const accountAtStart = accountRevision;
      requested = true;
      publish({ pending: true, status: 'connecting', accountCount: null, chainId: null });
      try {
        const count = accountCount(await selected.request({ method: 'eth_requestAccounts' }));
        if (token !== generation) return false;
        if (count === null) throw new Error('INVALID_ACCOUNTS');
        if (accountAtStart === accountRevision) publish({ accountCount: count });
        if (!state.accountCount) {
          publish({ status: state.accountCount === 0 ? 'disconnected' : 'error' });
          return false;
        }
        const chainAtStart = chainRevision;
        const chain = parseChainId(await selected.request({ method: 'eth_chainId' }));
        if (token !== generation) return false;
        if (chain === null) throw new Error('INVALID_CHAIN');
        if (chainAtStart === chainRevision) publish({ chainId: chain });
        publish({ status: observedStatus() });
        return state.status === 'connected';
      } catch (error) {
        if (token === generation) {
          requested = false;
          publish({
            status: error?.code === 4001 ? 'denied' : error?.code === -32002 ? 'external-pending' : 'error',
            accountCount: null, chainId: null,
          });
        }
        return false;
      } finally {
        publish({ pending: false });
      }
    },
    dispose() {
      this.select(null);
    },
  };
}

function trackDiagnostics(stream) {
  return stream ? stream.getVideoTracks().map((track) => {
    const settings = track.getSettings?.() ?? {};
    return {
      readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      width: Number.isFinite(settings.width) ? settings.width : 0,
      height: Number.isFinite(settings.height) ? settings.height : 0,
    };
  }) : [];
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function createCameraProbe({ getUserMedia, video, secureContext, isVisible, onChange }) {
  let generation = 0;
  let acquiring = null;
  let disposed = false;
  let stream = null;
  let removeTrackEvents = () => {};
  let state = { status: 'idle', pending: false, reason: '', tracks: [], video: null };
  const publish = (patch) => {
    state = { ...state, ...patch, pending: acquiring !== null };
    onChange({ ...state });
  };
  const release = () => {
    const previous = stream;
    stream = null;
    removeTrackEvents();
    removeTrackEvents = () => {};
    stopTracks(previous);
    video.pause();
    video.srcObject = null;
    return trackDiagnostics(previous);
  };
  const stop = (reason = 'manual') => {
    generation++;
    publish({ status: 'stopped', reason, tracks: release(), video: null });
  };
  const fail = (reason) => {
    generation++;
    publish({ status: 'error', reason, tracks: release(), video: null });
  };
  const update = (event) => {
    if (!stream) return;
    const tracks = trackDiagnostics(stream);
    const playback = {
      width: video.videoWidth, height: video.videoHeight,
      readyState: video.readyState, paused: video.paused,
    };
    const live = !video.paused && video.readyState >= 2 &&
      video.videoWidth > 0 && video.videoHeight > 0 &&
      tracks.some((track) => track.readyState === 'live' && !track.muted && track.enabled) &&
      event?.type !== 'waiting' && event?.type !== 'stalled';
    publish({ status: live ? 'live' : 'starting', tracks, video: playback, reason: '' });
  };
  const paused = () => { if (stream) fail('playback-stopped'); };
  const playbackError = () => { if (stream) fail('playback-failed'); };
  const videoEvents = ['playing', 'loadedmetadata', 'loadeddata', 'resize', 'waiting', 'stalled'];
  for (const event of videoEvents) video.addEventListener(event, update);
  video.addEventListener('pause', paused);
  video.addEventListener('error', playbackError);

  return {
    get state() { return { ...state }; },
    async start() {
      if (disposed || acquiring !== null || stream) return false;
      if (!secureContext) { fail('insecure'); return false; }
      if (!isVisible()) { fail('hidden'); return false; }
      if (!getUserMedia) { fail('unavailable'); return false; }
      const token = ++generation;
      acquiring = token;
      publish({ status: 'requesting', reason: '', tracks: [], video: null });
      let received = null;
      try {
        received = await getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (acquiring === token) acquiring = null;
        if (token !== generation || !isVisible() || disposed) {
          stopTracks(received);
          if (token === generation) stop('hidden');
          else publish({});
          return false;
        }
        if (!received.getVideoTracks().some((track) => track.readyState === 'live')) {
          stopTracks(received);
          fail('ended');
          return false;
        }
        stream = received;
        const ended = () => fail('ended');
        for (const track of stream.getVideoTracks()) {
          track.addEventListener('ended', ended);
          track.addEventListener('mute', update);
          track.addEventListener('unmute', update);
        }
        removeTrackEvents = () => {
          for (const track of received.getVideoTracks()) {
            track.removeEventListener('ended', ended);
            track.removeEventListener('mute', update);
            track.removeEventListener('unmute', update);
          }
        };
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        publish({ status: 'starting', tracks: trackDiagnostics(stream) });
        await video.play();
        if (token !== generation || !isVisible() || disposed) {
          stopTracks(received);
          if (token === generation) stop('hidden');
          return false;
        }
        update();
        return true;
      } catch (error) {
        if (acquiring === token) acquiring = null;
        stopTracks(received);
        if (token !== generation || disposed) { publish({}); return false; }
        const reasons = {
          NotAllowedError: 'denied', SecurityError: 'denied', NotFoundError: 'not-found',
          NotReadableError: 'busy', OverconstrainedError: 'constraints',
        };
        fail(received ? 'playback-failed' : (reasons[error?.name] ?? 'unavailable'));
        return false;
      }
    },
    stop,
    dispose() {
      disposed = true;
      stop('page-closed');
      for (const event of videoEvents) video.removeEventListener(event, update);
      video.removeEventListener('pause', paused);
      video.removeEventListener('error', playbackError);
    },
  };
}
