import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const origin = process.env.KALASH_TEST_ORIGIN ?? 'http://localhost:3000';
const walletPath = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets', 'wallets.json');
const wallets = JSON.parse(readFileSync(walletPath, 'utf8'));
const donor = privateKeyToAccount(wallets.donor.privateKey);
const other = privateKeyToAccount(wallets['temple-01'].privateKey);
let config;
let token;
let otherToken;
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
