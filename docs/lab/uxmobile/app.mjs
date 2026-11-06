import { drawQr } from './qr.mjs';
import {
  BASE_SEPOLIA, arrivalInfo, targetFor, buildDeepLink,
  createDiscovery, createWalletProbe, createCameraProbe,
} from './probe.mjs';

const element = (id) => document.getElementById(id);
const text = (id, value) => { element(id).textContent = value; };
const arrival = arrivalInfo(window.location.href);
text('arrival-case', `${arrival.testCase}（URL上の指定のみ）`);
text('arrival-origin', arrival.origin);
text('arrival-path', arrival.path);
if (arrival.phone) {
  document.body.classList.add('phone-mode');
  element('phone-panel').focus();
}

let qrGeneration = 0;
async function updateQr() {
  const generation = ++qrGeneration;
  const control = element('qr-destination').value === 'control';
  text('destination-note', control
    ? '比較用：ここからは隔離PoCの外です。本体は今もReownを使用します。URL引き渡しだけを確認し、本体で接続・署名・寄付を進めないでください。'
    : 'この独立PoCの同じhost・pathへ移動します。引き継ぐqueryはmode=phoneとcase=external-qrのみです。');
  const canvas = element('qr-canvas');
  canvas.hidden = true;
  for (const id of ['deep-link', 'direct-link']) {
    element(id).hidden = true;
    element(id).removeAttribute('href');
  }
  text('qr-payload', '—');
  text('target-url', '—');
  let payload;
  try {
    const target = targetFor(window.location.href, element('qr-destination').value);
    payload = buildDeepLink(target, window.location.href);
    text('qr-payload', payload);
    text('target-url', target);
    element('deep-link').href = payload;
    element('direct-link').href = target;
    element('deep-link').hidden = false;
    element('direct-link').hidden = false;
  } catch {
    text('qr-status', 'このURLは公開HTTPSではありません。localhost・HTTPのQRではスマホのカメラ確認はできません。実際の独立HTTPS配備先で開き直してください。偽のHTTPSリンクは作りません。');
    return;
  }
  text('qr-status', 'このページ内でQRを生成しています。');
  try {
    // Render offscreen so an older asynchronous draw cannot replace the selected QR.
    const drawing = document.createElement('canvas');
    await drawQr(drawing, payload);
    if (generation !== qrGeneration) return;
    canvas.width = drawing.width;
    canvas.height = drawing.height;
    canvas.getContext('2d').drawImage(drawing, 0, 0);
    canvas.hidden = false;
    text('qr-status', control
      ? '比較用の本体リンクです。PoCのWallet・カメラ試験は本体で行わないでください。'
      : 'QRを表示しました。スマホでの移動は未確認です。内容と行き先を下で確認してください。');
  } catch {
    if (generation === qrGeneration) text('qr-status', 'QR生成に失敗しました。上の行き先と下のリンクは確認できます。配信されたQRモジュールを確認してください。');
  }
}
element('qr-destination').addEventListener('change', updateQr);
void updateQr();

for (const input of document.querySelectorAll('input[name="test-context"]')) {
  input.addEventListener('change', () => {
    const labels = {
      unspecified: '未選択', 'pc-extension': 'PCのMetaMask拡張',
      'mobile-in-app': 'スマホのMetaMask内蔵Browser', 'external-browser': 'スマホの外部ブラウザ',
    };
    text('context-status', `環境の自己申告：${labels[input.value]}。自動判定・保存・送信はしません。`);
  });
}

let candidates = [];
let selected = null;
const walletMessages = {
  unselected: '未接続。候補を選び、本人が接続ボタンを押してください。',
  ready: '候補を選択しました。まだ接続要求はしていません。',
  connecting: 'MetaMaskへの接続要求を待っています。繰り返し押さず、Wallet側を確認してください。',
  connected: '接続アカウント数とチェーンを受け取りました。署名・認証・取引はしていません。',
  incomplete: 'Providerの状態が変わりました。接続情報は未確認です。必要なら本人が再接続してください。',
  disconnected: '切断またはアカウント未許可です。以前の接続成功は無効です。',
  denied: '接続が拒否されました（4001）。再試行は本人が必要と判断した場合だけ行ってください。',
  'external-pending': 'MetaMaskに処理中の要求があります（-32002）。Wallet側の既存要求を確認し、完了後に手動で再試行してください。',
  unsupported: 'この候補では状態変化イベントを安全に監視できません。このPoCでは接続しません。',
  error: '接続情報を確認できませんでした。以前の成功は無効です。Wallet側を確認してください。詳細やアドレスは記録しません。',
};
const wallet = createWalletProbe((state) => {
  text('wallet-status', walletMessages[state.status]);
  element('wallet-status').dataset.tone = ['denied', 'error', 'unsupported', 'external-pending'].includes(state.status) ? 'error'
    : state.status === 'connected' && state.chainId === BASE_SEPOLIA ? 'good' : '';
  text('wallet-account-count', state.accountCount === null ? '未確認' : `${state.accountCount} 件`);
  text('wallet-chain', state.chainId === null ? '未確認'
    : state.chainId === BASE_SEPOLIA ? 'Base Sepolia — 84532（一致）'
      : `別のチェーン — ${state.chainId}（Base Sepolia 84532ではありません。自動切替なし）`);
  element('provider-select').disabled = state.pending || candidates.length === 0;
  element('connect-wallet').disabled = state.pending || !selected || state.status === 'unsupported';
  element('refresh-providers').disabled = state.pending;
});

const discovery = createDiscovery({
  target: window,
  getEthereum: () => window.ethereum,
  onChange(next) {
    candidates = next;
    if (selected && !candidates.some((entry) => entry.provider === selected)) {
      selected = null;
      wallet.select(null);
    }
    const options = [new Option('候補を選んでください', '')];
    candidates.forEach((entry, index) => {
      options.push(new Option(`候補 ${index + 1} — ${entry.source} / MetaMask自己申告`, String(index)));
    });
    element('provider-select').replaceChildren(...options);
    const selectedIndex = candidates.findIndex((entry) => entry.provider === selected);
    element('provider-select').value = selectedIndex < 0 ? '' : String(selectedIndex);
    element('provider-select').disabled = wallet.state.pending || candidates.length === 0;
    text('provider-status', candidates.length === 0
      ? '対応するMetaMask候補は未検出です。スマホの外部ブラウザでは通常利用できません。PCのQRまたは「MetaMaskで開く」を本人が使ってください。遅れて検出した候補はここに表示します。'
      : `${candidates.length} 件の候補を検出。${candidates.length > 1 ? '複数あるため推測しません。' : ''}本人が選んでください。真正性やブラウザ種別の保証ではありません。`);
  },
});
element('provider-select').addEventListener('change', () => {
  const value = element('provider-select').value;
  selected = value === '' ? null : candidates[Number(value)]?.provider ?? null;
  wallet.select(selected);
});
element('refresh-providers').addEventListener('click', () => discovery.refresh());
element('connect-wallet').addEventListener('click', () => { void wallet.connect(); });
discovery.start();

const cameraMessages = {
  idle: '未開始。ボタンを押すまでカメラにアクセスしません。',
  requesting: 'カメラ許可を待っています。所有者本人がブラウザの許可を選択してください。',
  starting: '映像の再生・サイズを確認中です。まだライブ再生の確認はできていません。',
  live: 'ライブ再生中（再生状態・映像サイズ・トラック状態を確認）。画素の取得・保存・送信はしていません。',
  stopped: 'カメラを停止しました。再開には開始ボタンの操作が必要です。',
};
const cameraErrors = {
  insecure: '安全なコンテキストではありません。実際のHTTPS配備先で開いてください。',
  hidden: 'ページが非表示のため開始しません。表示してから本人が再試行してください。',
  unavailable: 'この環境ではカメラAPIを利用できないか、開始に失敗しました。',
  denied: 'カメラが拒否されました。ブラウザ・OSの許可設定を本人が確認してください。',
  'not-found': '利用できるカメラが見つかりません。',
  busy: 'カメラを読み取れません。他のアプリによる使用や端末の制限を確認してください。',
  constraints: '希望したカメラ条件を利用できません。端末と権限を確認してください。',
  ended: 'カメラのトラックが終了しました。以前のライブ表示は無効です。',
  'playback-failed': 'プレビューを再生できませんでした。取得済みのカメラは停止しました。',
  'playback-stopped': 'プレビューの再生が止まったためカメラも停止しました。',
};
const camera = createCameraProbe({
  getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
  video: element('camera-video'),
  secureContext: window.isSecureContext,
  isVisible: () => document.visibilityState === 'visible',
  onChange(state) {
    const pendingStop = state.pending && state.status === 'stopped';
    text('camera-status', pendingStop
      ? '停止を予約しました。許可待ちはブラウザ側で残る場合があります。後から返るトラックは直ちに停止します。許可要求を重ねません。'
      : state.status === 'error' ? cameraErrors[state.reason] : cameraMessages[state.status]);
    element('camera-status').dataset.tone = state.status === 'error' ? 'error' : state.status === 'live' ? 'good' : '';
    element('camera-start').disabled = state.pending || ['starting', 'live'].includes(state.status);
    element('camera-stop').disabled = !state.pending && !['starting', 'live'].includes(state.status);
    element('camera-video').hidden = !['starting', 'live'].includes(state.status);
    const lines = state.tracks.map((track, index) =>
      `video track ${index + 1}: ${track.readyState}; enabled=${track.enabled}; muted=${track.muted}; ${track.width} × ${track.height}`);
    if (state.video) lines.push(`playback: readyState=${state.video.readyState}; paused=${state.video.paused}; ${state.video.width} × ${state.video.height}`);
    text('camera-diagnostics', lines.join('\n') || '稼働中の映像なし。端末名・deviceId・画像内容は取得／記録しません。');
  },
});
text('camera-environment', window.isSecureContext
  ? window.location.protocol === 'https:'
    ? 'HTTPSの安全なコンテキストです。カメラの対応・許可・実際の再生はまだ未確認です。'
    : 'localhostの安全なコンテキストではPC内の診断だけ可能です。このURLでスマホのQR・カメラ試験はできません。'
  : '安全なコンテキストではありません。カメラは開始できません。公開HTTPS配備先が必要です。');
element('camera-start').addEventListener('click', () => { void camera.start(); });
element('camera-stop').addEventListener('click', () => camera.stop());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') camera.stop('hidden');
});
window.addEventListener('pagehide', () => {
  camera.stop('page-hidden');
  discovery.stop();
  selected = null;
  wallet.dispose();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) discovery.start();
});
window.addEventListener('beforeunload', () => {
  camera.dispose();
  discovery.stop();
  wallet.dispose();
});
