import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import sharp from 'sharp';
import { PHOTO_CONSENT_VERSION } from '../src/shared.ts';

const origin = process.env.KALASH_TEST_ORIGIN ?? 'http://localhost:3000';
const walletPath = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets', 'wallets.json');
const wallets = JSON.parse(readFileSync(walletPath, 'utf8'));
const donor = privateKeyToAccount(wallets.donor.privateKey);
const other = privateKeyToAccount(wallets['temple-01'].privateKey);
let config;
let token;
let otherToken;
let recoveryToken;
let nonceToReplay;
let replaySignature;
async function request(path, { method = 'GET', body, bearer, requestOrigin = origin } = {}) {
  return fetch(`${origin}${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Origin: requestOrigin, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(account) {
  const challengeResponse = await request('/api/auth/challenge', { method: 'POST', body: { wallet: account.address } });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  assert.match(challenge.message, /Chain ID: 84532/);
  assert.match(challenge.message, new RegExp(new URL(origin).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const signature = await account.signMessage({ message: challenge.message });
  const verification = await request('/api/auth/verify', { method: 'POST', body: { nonce: challenge.nonce, signature } });
  assert.equal(verification.status, 200, JSON.stringify(await verification.clone().json()));
  const { customToken } = await verification.json();
  const exchange = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.firebase.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }), signal: AbortSignal.timeout(20000),
  });
  assert.equal(exchange.status, 200);
  const { idToken } = await exchange.json();
  assert.ok(idToken);
  return { token: idToken, challenge, signature };
}
before(async () => {
  const ready = await request('/api/health');
  assert.equal(ready.status, 200, 'A real configured Central must be running; do not skip mandatory API tests.');
  config = await (await request('/api/config')).json();
  assert.equal(config.chainId, 84532);
  const first = await login(donor);
  token = first.token;
  nonceToReplay = first.challenge.nonce;
  replaySignature = first.signature;
  otherToken = (await login(other)).token;
  recoveryToken = (await login(privateKeyToAccount(generatePrivateKey()))).token;
});
test('real Firebase session, one-use SIWE and cross-wallet signature rejection', async () => {
  const replay = await request('/api/auth/verify', { method: 'POST', body: { nonce: nonceToReplay, signature: replaySignature } });
  assert.equal(replay.status, 401);
  const challenge = await (await request('/api/auth/challenge', { method: 'POST', body: { wallet: donor.address } })).json();
  const wrong = await request('/api/auth/verify', {
    method: 'POST', body: { nonce: challenge.nonce, signature: await other.signMessage({ message: challenge.message }) },
  });
  assert.equal(wrong.status, 401);
});
test('real API authorization: missing/invalid identity and foreign origin are rejected', async () => {
  assert.equal((await request('/api/collection')).status, 401);
  assert.equal((await request('/api/history', { bearer: 'invalid' })).status, 401);
  assert.equal((await request('/api/donations', {
    method: 'POST', bearer: token, requestOrigin: 'https://other.invalid', body: { templeId: 'temple-01', amount: '0.01' },
  })).status, 403);
});
test('real Firestore rules deny direct client access despite a valid Firebase session', async () => {
  const direct = await fetch(`https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents/temples?pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  assert.equal(direct.status, 403, 'Only Central IAM may read/write business data; Firebase login is not database permission.');
});
test('real API catalog/amounts/owner restrictions persist exact immutable intent', async () => {
  const catalog = await (await request('/api/temples')).json();
  assert.equal(catalog.temples.length, 10);
  assert.equal(catalog.temples.filter((temple) => temple.onsite).length, 1);
  for (const amount of ['0', '1.000001', '0.0000001', '0.0100000', '-1', '1e-2', 0.01]) {
    const response = await request('/api/donations', { method: 'POST', bearer: token, body: { templeId: 'temple-01', amount } });
    assert.equal(response.status, 400, `must reject ${amount}`);
  }
  assert.equal((await request('/api/donations', { method: 'POST', bearer: token, body: {
    templeId: 'temple-01', amount: '0.01', recipient: other.address,
  } })).status, 400);
  const response = await request('/api/donations', { method: 'POST', bearer: token, body: { templeId: 'temple-01', amount: '0.01' } });
  assert.equal(response.status, 201);
  const donation = await response.json();
  assert.equal(donation.amount, '10000');
  assert.equal(donation.fee, '1');
  assert.equal(donation.net, '9999');
  assert.equal(donation.kind, 0);
  assert.equal(donation.recipient.toLowerCase(), wallets['temple-01'].address.toLowerCase());
  assert.equal((await request(`/api/donations/${donation.id}`, { bearer: otherToken })).status, 403);
  assert.equal((await request(`/api/donations/${donation.id}/verify`, { method: 'POST', bearer: otherToken, body: {} })).status, 403);
  const reload = await (await request(`/api/donations/${donation.id}`, { bearer: token })).json();
  assert.equal(reload.id, donation.id);
  assert.equal(reload.status, 'intent');
  const cap = await request('/api/donations', { method: 'POST', bearer: token, body: { templeId: 'temple-01', amount: '1' } });
  assert.equal(cap.status, 201);
  assert.equal((await cap.json()).amount, '1000000');
  const collection = await (await request('/api/collection', { bearer: token })).json();
  assert.ok(Array.isArray(collection.donations));
  assert.equal(collection.donations.filter((entry) => entry.id === donation.id).length, 1);
});
test('real operation registration is idempotent and unknown submission cannot be reissued', async () => {
  const response = await request('/api/donations', { method: 'POST', bearer: token, body: { templeId: 'temple-01', amount: '0.01' } });
  assert.equal(response.status, 201);
  const donation = await response.json();
  const operation = { operation: 'donate', attemptId: crypto.randomUUID() };
  for (let count = 0; count < 2; count++) {
    const response = await request(`/api/donations/${donation.id}/operation`, { method: 'POST', bearer: token, body: operation });
    assert.equal(response.status, 200);
  }
  assert.equal((await request(`/api/donations/${donation.id}/operation`, {
    method: 'POST', bearer: token, body: { operation: 'donate', attemptId: crypto.randomUUID() },
  })).status, 409);
  const unsafeResolution = await request(`/api/donations/${donation.id}/resolve-approval`, {
    method: 'POST', bearer: token, body: { attemptId: operation.attemptId, confirmNoWalletRequest: true },
  });
  assert.equal(unsafeResolution.status, 409, 'an active donate attempt must never be abandoned as approval-only');

  const approvalIntent = await request('/api/donations', {
    method: 'POST', bearer: recoveryToken, body: { templeId: 'temple-01', amount: '0.01' },
  });
  assert.equal(approvalIntent.status, 201);
  const approval = await approvalIntent.json();
  const approvalAttemptId = crypto.randomUUID();
  assert.equal((await request(`/api/donations/${approval.id}/operation`, {
    method: 'POST', bearer: recoveryToken, body: { operation: 'approve', attemptId: approvalAttemptId },
  })).status, 200);
  const history = await (await request('/api/history', { bearer: recoveryToken })).json();
  assert.equal(history.donations.find((entry) => entry.id === approval.id).approvalAttemptId, approvalAttemptId);
  const foreignHistory = await (await request('/api/history', { bearer: otherToken })).json();
  assert.equal(foreignHistory.donations.some((entry) => entry.id === approval.id), false);
  const missingWalletConfirmation = await request(`/api/donations/${approval.id}/resolve-approval`, {
    method: 'POST', bearer: recoveryToken, body: { attemptId: approvalAttemptId },
  });
  assert.equal(missingWalletConfirmation.status, 400, 'recovery requires explicit confirmation that no wallet prompt is open');
  const earlyResolution = await request(`/api/donations/${approval.id}/resolve-approval`, {
    method: 'POST', bearer: recoveryToken,
    body: { attemptId: approvalAttemptId, confirmNoWalletRequest: true },
  });
  assert.equal(earlyResolution.status, 200);
  const resolvedApproval = await earlyResolution.json();
  assert.equal(resolvedApproval.status, 'cancelled');
  assert.equal(resolvedApproval.approvalResolution.outcome, 'cancelled');
  assert.equal(resolvedApproval.approvalResolution.onchainRevoked, false);
  assert.equal(resolvedApproval.approvalResolution.confirmedNoWalletRequest, true);
  assert.equal(resolvedApproval.approvalResolution.approvalEvents, 0);
  assert.equal(resolvedApproval.approvalResolution.donatedEvents, 0);
  assert.equal((await (await request(`/api/donations/${approval.id}`, { bearer: recoveryToken })).json()).status, 'cancelled');
  const repeatResolution = await request(`/api/donations/${approval.id}/resolve-approval`, {
    method: 'POST', bearer: recoveryToken,
    body: { attemptId: approvalAttemptId, confirmNoWalletRequest: true },
  });
  assert.equal(repeatResolution.status, 200, 'recovery is idempotent for the same approval attempt');
  const blockedNewIntent = await request('/api/donations', {
    method: 'POST', bearer: recoveryToken, body: { templeId: 'temple-01', amount: '0.01' },
  });
  assert.equal(blockedNewIntent.status, 409, 'a new signed intent is blocked until the abandoned signature deadline');
  assert.match((await blockedNewIntent.json()).message, /No new intent or MetaMask request was created/);

  const unknown = await request(`/api/donations/${donation.id}/verify`, { method: 'POST', bearer: token, body: {} });
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).status, 'unknown');
});
test('real Collection points equal exactly confirmed gross donations, excluding all pending intents', async () => {
  const collection = await (await request('/api/collection', { bearer: token })).json();
  const expected = {};
  const ids = new Set();
  for (const donation of collection.donations) {
    assert.ok(!ids.has(donation.id), 'donationId cannot appear twice in persisted history');
    ids.add(donation.id);
    if (donation.status !== 'confirmed') continue;
    expected[donation.templeId] = (expected[donation.templeId] ?? 0n) + BigInt(donation.amount);
    assert.equal(donation.fee, (BigInt(donation.amount) / 10000n).toString());
    if (donation.mintStatus === 'minted') {
      assert.equal(donation.tokenId, BigInt(donation.id).toString());
      assert.match(donation.mintTxHash, /^0x[0-9a-f]{64}$/i);
    }
  }
  for (const [templeId, points] of Object.entries(collection.points)) assert.equal(BigInt(points), expected[templeId] ?? 0n);
  for (const [templeId, points] of Object.entries(expected)) assert.equal(BigInt(collection.points[templeId]), points);
});

test('real photo consent, private storage delivery, board listing and withdrawal are enforced', async () => {
  const collection = await (await request('/api/collection', { bearer: token })).json();
  const donation = collection.donations.find((entry) => entry.status === 'confirmed');
  assert.ok(donation, 'photo sharing requires an existing confirmed donation');
  const initialBoard = await (await request(`/api/board/${donation.templeId}/photos`)).json();
  const priorPhotoIds = initialBoard.photos.map((photo) => photo.id).sort();
  const portrait = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200">
    <rect width="160" height="200" fill="#e8d9b8"/><circle cx="80" cy="68" r="36" fill="#b87953"/>
    <path d="M25 200c4-48 24-72 55-72s51 24 55 72" fill="#17604c"/>
    <circle cx="67" cy="66" r="3" fill="#282421"/><circle cx="93" cy="66" r="3" fill="#282421"/>
    <path d="M68 85q12 10 24 0" fill="none" stroke="#542f25" stroke-width="3"/>
  </svg>`);
  const image = await sharp(portrait).png().toBuffer();
  const base = {
    donationId: donation.id,
    imageBase64: image.toString('base64'),
    contentType: 'image/png',
    displayName: 'E2E pilgrim',
    consentVersion: PHOTO_CONSENT_VERSION,
  };
  const noConsent = await request('/api/photos', {
    method: 'POST', bearer: token, body: { ...base, consent: false },
  });
  assert.equal(noConsent.status, 400);

  let photoId;
  try {
    const upload = await request('/api/photos', {
      method: 'POST', bearer: token, body: { ...base, consent: true },
    });
    assert.equal(upload.status, 201, JSON.stringify(await upload.clone().json()));
    const result = await upload.json();
    const { photo } = result;
    photoId = photo.id;
    assert.equal(photo.templeId, donation.templeId);
    assert.equal(photo.displayName, 'E2E pilgrim');
    assert.ok([1, 2, 3, 4].includes(photo.sizeTier));
    assert.ok(photo.imageUrl.startsWith('/api/board/'));
    for (const privateField of ['ownerWallet', 'donationId', 'pointsAtPublish', 'objectName']) {
      assert.equal(Object.hasOwn(photo, privateField), false);
    }

    const board = await (await request(`/api/board/${donation.templeId}/photos`)).json();
    assert.deepEqual(board.photos.map((item) => item.id).sort(), [...priorPhotoIds, photo.id].sort());
    const imageResponse = await fetch(`${origin}${photo.imageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/jpeg');
    assert.match(imageResponse.headers.get('cache-control') ?? '', /no-store/);

    const replacement = await request('/api/photos', {
      method: 'POST', bearer: token, body: { ...base, consent: true },
    });
    assert.equal(replacement.status, 201);
    const replacementPhoto = (await replacement.json()).photo;
    assert.notEqual(replacementPhoto.id, photo.id);
    photoId = replacementPhoto.id;
    assert.equal((await fetch(`${origin}${photo.imageUrl}`)).status, 404);
    const replacedBoard = await (await request(`/api/board/${donation.templeId}/photos`)).json();
    assert.deepEqual(replacedBoard.photos.map((item) => item.id).sort(), [...priorPhotoIds, replacementPhoto.id].sort());

    const foreignWithdraw = await request(`/api/photos/${replacementPhoto.id}/withdraw`, {
      method: 'POST', bearer: otherToken, body: {},
    });
    assert.equal(foreignWithdraw.status, 404);
  } finally {
    if (photoId) {
      const withdrawn = await request(`/api/photos/${photoId}/withdraw`, {
        method: 'POST', bearer: token, body: {},
      });
      assert.equal(withdrawn.status, 200);
      assert.equal((await fetch(`${origin}/api/board/${donation.templeId}/photos/${photoId}`)).status, 404);
      const restoredBoard = await (await request(`/api/board/${donation.templeId}/photos`)).json();
      assert.deepEqual(restoredBoard.photos.map((item) => item.id).sort(), priorPhotoIds);
      const ownPhotos = await (await request('/api/photos/mine', { bearer: token })).json();
      assert.equal(ownPhotos.photos.some((photo) => photo.id === photoId), false);
    }
  }
});
