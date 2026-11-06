import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  BASE_SEPOLIA, CONTROL_TARGET, phoneTarget, targetFor, buildDeepLink, isAllowedTarget,
  arrivalInfo, providerCandidates, isMetaMaskCandidate, createDiscovery,
  parseChainId, createWalletProbe, createCameraProbe,
} from './probe.mjs';

const current = 'https://probe.example.test/lab/uxmobile/';
const account = `0x${'1'.repeat(40)}`;
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('phone target keeps the HTTPS host, port and escaped nested path, with only public markers', () => {
  assert.equal(
    phoneTarget('https://probe.example.test:8443/lab/%E5%AF%BA/a%2Fb?secret=do-not-copy&next=https%3A%2F%2Felsewhere.test#private'),
    'https://probe.example.test:8443/lab/%E5%AF%BA/a%2Fb?mode=phone&case=external-qr',
  );
});

test('deep link keeps destination path/query and removes only the target scheme', () => {
  const target = phoneTarget(current);
  assert.equal(buildDeepLink(target, current),
    'https://link.metamask.io/dapp/probe.example.test/lab/uxmobile/?mode=phone&case=external-qr');
  const nested = 'https://probe.example.test/a%2Fb/%E5%AF%BA';
  assert.equal(buildDeepLink(phoneTarget(nested), nested),
    'https://link.metamask.io/dapp/probe.example.test/a%2Fb/%E5%AF%BA?mode=phone&case=external-qr');
});

test('non-HTTPS and loopback targets never become fake mobile destinations', () => {
  for (const url of [
    'http://probe.example.test/', 'http://localhost:3000/', 'https://localhost/',
    'https://a.localhost/', 'https://127.0.0.1/', 'https://[::1]/',
    'https://0.0.0.0/', 'https://desktop.local/', 'https://user:password@probe.example.test/',
  ]) assert.throws(() => phoneTarget(url), /PUBLIC_HTTPS_REQUIRED/u);
});

test('only the exact current PoC target and fixed canonical control are allowed', () => {
  assert.equal(targetFor(current, 'isolated'), phoneTarget(current));
  assert.equal(targetFor(current, 'control'), CONTROL_TARGET);
  assert.equal(isAllowedTarget(CONTROL_TARGET, 'http://localhost/'), true);
  assert.equal(buildDeepLink(CONTROL_TARGET, current),
    'https://link.metamask.io/dapp/kalash-central-548318651344.asia-south1.run.app/temples/temple-01');
  for (const url of [
    'https://attacker.example/', `${CONTROL_TARGET}?next=https://attacker.example`,
    `${phoneTarget(current)}&redirect=https://attacker.example`, `${phoneTarget(current)}#extra`,
    'javascript:alert(1)', '//attacker.example/', 'https://probe.example.test/other?mode=phone&case=external-qr',
  ]) {
    assert.equal(isAllowedTarget(url, current), false);
    assert.throws(() => buildDeepLink(url, current), /TARGET_NOT_ALLOWED/u);
  }
  assert.throws(() => targetFor(current, 'https://attacker.example/'), /TARGET_NOT_ALLOWED/u);
});

test('arrival markers expose no arbitrary query values and are not arrival provenance', () => {
  assert.deepEqual(arrivalInfo(`${current}?mode=phone&case=external-qr&address=private`), {
    phone: true, testCase: 'external-qr', origin: 'https://probe.example.test', path: '/lab/uxmobile/',
  });
  assert.equal(arrivalInfo(`${current}?case=anything-secret`).testCase, '未指定 / 未対応');
  assert.equal(arrivalInfo(current).phone, false);
});

class Provider extends EventEmitter {
  isMetaMask = true;
  calls = [];
  constructor(request = async ({ method }) => method === 'eth_requestAccounts' ? [account] : '0x14a34') {
    super();
    this.handler = request;
  }
  request(args) { this.calls.push(args.method); return this.handler(args); }
}
const announcement = (provider, rdns = 'io.metamask') => ({ provider, info: { rdns } });

test('EIP-6963 requires both io.metamask and isMetaMask and deduplicates identity', () => {
  const first = new Provider();
  const other = new Provider();
  other.isMetaMask = false;
  assert.deepEqual(providerCandidates([
    announcement(first), announcement(first), announcement(other),
  ], undefined), [{ provider: first, source: 'EIP-6963' }]);
  assert.equal(providerCandidates([announcement(first, 'com.other')], first).length, 0);
  assert.equal(isMetaMaskCandidate({ isMetaMask: true }), false);
});

test('conflicting self-asserted flags or announcements disqualify legacy fallback', () => {
  const claimed = new Provider();
  claimed.isRabby = true;
  assert.equal(providerCandidates([], claimed).length, 0);
  const conflicting = new Provider();
  assert.equal(providerCandidates([
    announcement(conflicting), announcement(conflicting, 'com.other'),
  ], conflicting).length, 0);
});

test('legacy provider arrays do not select their aggregator or hide multiple candidates', () => {
  const first = new Provider();
  const second = new Provider();
  const other = { request() {}, isCoinbaseWallet: true };
  const aggregator = new Provider();
  aggregator.providers = [first, other, second, first];
  assert.deepEqual(providerCandidates([], aggregator).map((entry) => entry.provider), [first, second]);
  assert.deepEqual(providerCandidates([announcement(first), announcement(second)], aggregator)
    .map((entry) => entry.provider), [first, second]);
});

test('announced candidates take precedence over a legacy fallback without making RPC calls', () => {
  const announced = new Provider();
  const legacy = new Provider();
  assert.deepEqual(providerCandidates([announcement(announced)], legacy)
    .map((entry) => entry.provider), [announced]);
  assert.equal(announced.calls.length + legacy.calls.length, 0);
});

test('discovery handles delayed announcement, legacy initialization and listener cleanup', () => {
  const target = new EventTarget();
  const results = [];
  let ethereum;
  let requests = 0;
  target.addEventListener('eip6963:requestProvider', () => { requests++; });
  const discovery = createDiscovery({ target, getEthereum: () => ethereum, onChange: (value) => results.push(value) });
  discovery.start();
  discovery.start();
  assert.equal(requests, 1);
  assert.equal(results.at(-1).length, 0);
  ethereum = new Provider();
  target.dispatchEvent(new Event('ethereum#initialized'));
  assert.equal(results.at(-1)[0].source, 'legacy injection');
  const announced = new Provider();
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: announcement(announced) });
  target.dispatchEvent(event);
  assert.equal(results.at(-1)[0].provider, announced);
  discovery.stop();
  const count = results.length;
  target.dispatchEvent(event);
  target.dispatchEvent(new Event('ethereum#initialized'));
  discovery.refresh();
  assert.equal(results.length, count);
  discovery.start();
  assert.equal(results.at(-1)[0].provider, ethereum);
  discovery.stop();
});

test('chain IDs are parsed conservatively', () => {
  assert.equal(parseChainId('0x14a34'), BASE_SEPOLIA);
  for (const value of ['84532', '', '0x', '0x0', '0x20000000000000', 84532, null]) {
    assert.equal(parseChainId(value), null);
  }
});

test('wallet does nothing until selection and explicit connect; only two RPC methods occur', async () => {
  const states = [];
  const wallet = createWalletProbe((state) => states.push(state));
  assert.equal(await wallet.connect(), false);
  const provider = new Provider();
  wallet.select(provider);
  assert.deepEqual(provider.calls, []);
  assert.equal(await wallet.connect(), true);
  assert.deepEqual(provider.calls, ['eth_requestAccounts', 'eth_chainId']);
  assert.equal(wallet.state.accountCount, 1);
  assert.equal(wallet.state.chainId, BASE_SEPOLIA);
  assert.equal(JSON.stringify(states).includes(account), false);
  wallet.dispose();
  assert.equal(provider.eventNames().length, 0);
});

test('wallet wrong chain and account/chain/disconnect events replace prior success', async () => {
  const provider = new Provider(async ({ method }) => method === 'eth_requestAccounts' ? [account] : '0x1');
  const wallet = createWalletProbe(() => {});
  wallet.select(provider);
  await wallet.connect();
  assert.equal(wallet.state.chainId, 1);
  provider.emit('chainChanged', '0x14a34');
  assert.equal(wallet.state.chainId, BASE_SEPOLIA);
  provider.emit('accountsChanged', []);
  assert.equal(wallet.state.status, 'disconnected');
  assert.equal(wallet.state.accountCount, 0);
  assert.equal(wallet.state.chainId, null);
  provider.emit('disconnect', { code: 4900, message: 'not logged' });
  provider.emit('chainChanged', '0x1');
  assert.equal(wallet.state.status, 'disconnected');
  assert.equal(wallet.state.chainId, null);
  wallet.dispose();
});

test('wallet request is single-flight and disconnect invalidates a late result', async () => {
  const response = deferred();
  const provider = new Provider(() => response.promise);
  const wallet = createWalletProbe(() => {});
  wallet.select(provider);
  const pending = wallet.connect();
  assert.equal(await wallet.connect(), false);
  provider.emit('disconnect');
  assert.equal(wallet.state.pending, true);
  response.resolve([account]);
  assert.equal(await pending, false);
  assert.equal(wallet.state.status, 'disconnected');
  assert.equal(wallet.state.pending, false);
  assert.deepEqual(provider.calls, ['eth_requestAccounts']);
  wallet.dispose();
});

test('new chain events win over stale in-flight chain response', async () => {
  const response = deferred();
  const provider = new Provider(({ method }) => method === 'eth_requestAccounts' ? [account] : response.promise);
  const wallet = createWalletProbe(() => {});
  wallet.select(provider);
  const pending = wallet.connect();
  await tick();
  provider.emit('chainChanged', '0x1');
  response.resolve('0x14a34');
  await pending;
  assert.equal(wallet.state.chainId, 1);
  wallet.dispose();
});

test('new accounts event wins over a stale in-flight accounts response', async () => {
  const response = deferred();
  const provider = new Provider(() => response.promise);
  const wallet = createWalletProbe(() => {});
  wallet.select(provider);
  const pending = wallet.connect();
  provider.emit('accountsChanged', []);
  response.resolve([account]);
  await pending;
  assert.equal(wallet.state.status, 'disconnected');
  assert.equal(wallet.state.accountCount, 0);
  assert.deepEqual(provider.calls, ['eth_requestAccounts']);
  wallet.dispose();
});

test('wallet denied, external-pending and unknown errors clear old successful data', async () => {
  for (const [code, status] of [[4001, 'denied'], [-32002, 'external-pending'], [123, 'error']]) {
    const provider = new Provider();
    const wallet = createWalletProbe(() => {});
    wallet.select(provider);
    await wallet.connect();
    provider.handler = async () => { throw { code, message: account }; };
    assert.equal(await wallet.connect(), false);
    assert.equal(wallet.state.status, status);
    assert.equal(wallet.state.pending, false);
    assert.equal(wallet.state.accountCount, null);
    assert.equal(wallet.state.chainId, null);
    assert.equal(JSON.stringify(wallet.state).includes(account), false);
    wallet.dispose();
  }
});

test('wallet selection change removes old listeners and invalidates pending response', async () => {
  const response = deferred();
  const old = new Provider(() => response.promise);
  const next = new Provider();
  const wallet = createWalletProbe(() => {});
  wallet.select(old);
  const pending = wallet.connect();
  wallet.select(next);
  assert.equal(old.eventNames().length, 0);
  response.resolve([account]);
  await pending;
  assert.equal(wallet.state.status, 'ready');
  assert.equal(wallet.state.accountCount, null);
  wallet.dispose();
  assert.equal(next.eventNames().length, 0);
});

test('wallet missing events or malformed responses is not a successful connection', async () => {
  const wallet = createWalletProbe(() => {});
  wallet.select({ request() { throw new Error('must not call'); } });
  assert.equal(await wallet.connect(), false);
  assert.equal(wallet.state.status, 'unsupported');
  for (const response of [null, ['not-an-address']]) {
    wallet.select(new Provider(async () => response));
    assert.equal(await wallet.connect(), false);
    assert.equal(wallet.state.status, 'error');
  }
  wallet.dispose();
});

test('failed listener cleanup is reported without payloads and stale providers cannot change state', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  const old = new Provider();
  old.removeListener = () => { throw new Error(account); };
  const next = new Provider();
  const wallet = createWalletProbe(() => {});
  wallet.select(old);
  await wallet.connect();
  wallet.select(next);
  await wallet.connect();
  const currentState = wallet.state;
  old.emit('accountsChanged', []);
  old.emit('chainChanged', '0x1');
  old.emit('disconnect');
  assert.deepEqual(wallet.state, currentState);
  assert.equal(warning.mock.callCount(), 3);
  assert.equal(JSON.stringify(warning.mock.calls.map((call) => call.arguments)).includes(account), false);
  wallet.dispose();
});

class Track extends EventTarget {
  readyState = 'live';
  enabled = true;
  muted = false;
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
  getSettings() { return { width: 1280, height: 720, deviceId: 'private-device', groupId: 'private-group' }; }
}
class Video extends EventTarget {
  srcObject = null;
  paused = true;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  playHandler = async () => {};
  async play() {
    await this.playHandler();
    this.paused = false;
    this.readyState = 2;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.dispatchEvent(new Event('playing'));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}
function cameraFixture(overrides = {}) {
  const video = new Video();
  const track = new Track();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const states = [];
  const requests = [];
  let visible = true;
  const camera = createCameraProbe({
    video, secureContext: true, isVisible: () => visible,
    getUserMedia: async (constraints) => { requests.push(constraints); return stream; },
    onChange: (state) => states.push(state),
    ...overrides,
  });
  return { video, track, stream, camera, states, requests, hide: () => { visible = false; } };
}

test('camera is explicit, requests video-only environment preference, and reports no device identifiers', async () => {
  const fixture = cameraFixture();
  assert.equal(fixture.requests.length, 0);
  assert.equal(await fixture.camera.start(), true);
  assert.deepEqual(fixture.requests, [{ video: { facingMode: { ideal: 'environment' } }, audio: false }]);
  assert.equal(fixture.camera.state.status, 'live');
  assert.equal(fixture.video.muted, true);
  assert.equal(fixture.video.playsInline, true);
  assert.equal(fixture.camera.state.tracks[0].width, 1280);
  assert.equal(JSON.stringify(fixture.states).includes('private-'), false);
  fixture.camera.stop();
  assert.equal(fixture.track.readyState, 'ended');
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.camera.state.status, 'stopped');
  fixture.camera.dispose();
});

test('insecure, hidden or unavailable camera environments never request permission', async () => {
  for (const [override, reason] of [
    [{ secureContext: false }, 'insecure'],
    [{ isVisible: () => false }, 'hidden'],
    [{ getUserMedia: undefined }, 'unavailable'],
  ]) {
    const fixture = cameraFixture(override);
    assert.equal(await fixture.camera.start(), false);
    assert.equal(fixture.camera.state.reason, reason);
    assert.equal(fixture.requests.length, 0);
    fixture.camera.dispose();
  }
});

test('manual stop during permission wait stops a late stream without allowing duplicate requests', async () => {
  const response = deferred();
  const fixture = cameraFixture({ getUserMedia: () => response.promise });
  const pending = fixture.camera.start();
  fixture.camera.stop();
  assert.equal(fixture.camera.state.pending, true);
  assert.equal(await fixture.camera.start(), false);
  response.resolve(fixture.stream);
  assert.equal(await pending, false);
  assert.equal(fixture.track.readyState, 'ended');
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.camera.state.pending, false);
  assert.equal(fixture.camera.state.status, 'stopped');
  fixture.camera.dispose();
});

test('hidden document during permission wait stops a late stream even without a stop notification', async () => {
  const response = deferred();
  const fixture = cameraFixture({ getUserMedia: () => response.promise });
  const pending = fixture.camera.start();
  fixture.hide();
  response.resolve(fixture.stream);
  assert.equal(await pending, false);
  assert.equal(fixture.track.readyState, 'ended');
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.camera.state.status, 'stopped');
  fixture.camera.dispose();
});

test('unload/dispose during pending permission stops returned tracks and prevents restart', async () => {
  const response = deferred();
  const fixture = cameraFixture({ getUserMedia: () => response.promise });
  const pending = fixture.camera.start();
  fixture.camera.dispose();
  response.resolve(fixture.stream);
  assert.equal(await pending, false);
  assert.equal(fixture.track.readyState, 'ended');
  assert.equal(await fixture.camera.start(), false);
});

test('camera denial is visible, retry is manual and late denied requests do not replace stopped state', async () => {
  const fixture = cameraFixture({ getUserMedia: async () => { throw { name: 'NotAllowedError' }; } });
  assert.equal(await fixture.camera.start(), false);
  assert.equal(fixture.camera.state.status, 'error');
  assert.equal(fixture.camera.state.reason, 'denied');
  assert.equal(fixture.camera.state.pending, false);
  fixture.camera.dispose();
  const response = deferred();
  const late = cameraFixture({ getUserMedia: () => response.promise });
  const pending = late.camera.start();
  late.camera.stop();
  response.reject({ name: 'NotAllowedError' });
  await pending;
  assert.equal(late.camera.state.status, 'stopped');
  assert.equal(late.camera.state.pending, false);
  late.camera.dispose();
});

test('failed playback stops all acquired tracks rather than claiming live preview', async () => {
  const fixture = cameraFixture();
  fixture.video.playHandler = async () => { throw new Error('blocked playback'); };
  assert.equal(await fixture.camera.start(), false);
  assert.equal(fixture.track.readyState, 'ended');
  assert.equal(fixture.camera.state.status, 'error');
  assert.equal(fixture.camera.state.reason, 'playback-failed');
  assert.equal(fixture.video.srcObject, null);
  fixture.camera.dispose();
});

test('ended tracks and unexpected video pause invalidate live camera state', async () => {
  for (const action of ['ended', 'pause']) {
    const fixture = cameraFixture();
    await fixture.camera.start();
    if (action === 'ended') {
      fixture.track.readyState = 'ended';
      fixture.track.dispatchEvent(new Event('ended'));
    } else fixture.video.pause();
    assert.equal(fixture.camera.state.status, 'error');
    assert.equal(fixture.video.srcObject, null);
    assert.equal(fixture.track.readyState, 'ended');
    fixture.camera.dispose();
  }
});

test('track mute and playback stalls no longer claim live playback', async () => {
  const fixture = cameraFixture();
  await fixture.camera.start();
  fixture.track.muted = true;
  fixture.track.dispatchEvent(new Event('mute'));
  assert.equal(fixture.camera.state.status, 'starting');
  fixture.track.muted = false;
  fixture.track.dispatchEvent(new Event('unmute'));
  assert.equal(fixture.camera.state.status, 'live');
  fixture.video.dispatchEvent(new Event('waiting'));
  assert.equal(fixture.camera.state.status, 'starting');
  fixture.video.dispatchEvent(new Event('playing'));
  assert.equal(fixture.camera.state.status, 'live');
  fixture.camera.dispose();
});

test('stale play rejection cannot clear a newer pending camera permission request', async () => {
  const play = deferred();
  const request = deferred();
  let calls = 0;
  const fixture = cameraFixture({ getUserMedia: () => ++calls === 1 ? fixture.stream : request.promise });
  fixture.video.playHandler = () => play.promise;
  const old = fixture.camera.start();
  await tick();
  fixture.camera.stop();
  const next = fixture.camera.start();
  play.reject(new Error('old playback stopped'));
  await old;
  assert.equal(fixture.camera.state.pending, true);
  assert.equal(await fixture.camera.start(), false);
  assert.equal(calls, 2);
  fixture.camera.stop();
  const nextTrack = new Track();
  request.resolve({ getTracks: () => [nextTrack], getVideoTracks: () => [nextTrack] });
  await next;
  assert.equal(nextTrack.readyState, 'ended');
  fixture.camera.dispose();
});

test('dispose removes camera event listeners and no late media event changes state', async () => {
  const fixture = cameraFixture();
  await fixture.camera.start();
  fixture.camera.dispose();
  const count = fixture.states.length;
  fixture.video.dispatchEvent(new Event('playing'));
  fixture.track.dispatchEvent(new Event('ended'));
  assert.equal(fixture.states.length, count);
});
