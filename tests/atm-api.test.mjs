import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const origin = process.env.KALASH_TEST_ORIGIN ?? 'http://localhost:3000';
const fixture = `atm-test-${randomUUID()}`;
const second = `${fixture}-b`;
const credential = randomBytes(32).toString('hex');
const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
const tokens = [];
let db;
let config;
let cookie;
let otherCookie;
let usedPairCode;
let visit;
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function request(path, { method = 'GET', body, token, screen, requestOrigin = origin } = {}) {
  return fetch(`${origin}${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: {
      Origin: requestOrigin, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(screen ? { Cookie: screen } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function login(account) {
  const challengeResponse = await request('/api/auth/challenge', { method: 'POST', body: { wallet: account.address } });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const signature = await account.signMessage({ message: challenge.message });
  const response = await request('/api/auth/verify', { method: 'POST', body: { nonce: challenge.nonce, signature } });
  assert.equal(response.status, 200);
  const { customToken } = await response.json();
  const exchange = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.firebase.apiKey}`, {
    method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.equal(exchange.status, 200);
  return (await exchange.json()).idToken;
}
async function pair(atmId) {
  const issued = await request(`/api/controller/${atmId}/pairing`, { method: 'POST', token: credential, body: {} });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const paired = await request(`/api/atm/${atmId}/pair`, { method: 'POST', body: { code } });
  assert.equal(paired.status, 200);
  const header = paired.headers.get('set-cookie');
  assert.match(header, /HttpOnly; SameSite=Strict/);
  assert.match(header, new RegExp(`Path=/api/atm/${atmId}`));
  if (origin.startsWith('https:')) assert.match(header, /Secure/);
  return { cookie: header.split(';')[0], code };
}
before(async () => {
  const ready = await request('/api/health');
  assert.equal(ready.status, 200, 'A real Central is mandatory; ATM API tests must not skip.');
  config = await (await request('/api/config')).json();
  initializeApp({ credential: applicationDefault(), projectId: config.firebase.projectId });
  db = getFirestore();
  for (const id of [fixture, second]) {
    await db.collection('atms').doc(id).create({
      id, name: 'Isolated reception test', templeId: 'temple-01', enabled: true, credentialHash: hash(credential),
    });
  }
  const firstPair = await pair(fixture);
  cookie = firstPair.cookie;
  usedPairCode = firstPair.code;
  otherCookie = (await pair(second)).cookie;
  for (const account of accounts) tokens.push(await login(account));
});
after(async () => {
  if (!db) return;
  for (const id of [fixture, second]) {
    for (const name of ['visits', 'visitChallenges', 'atmPairings']) {
      const records = await db.collection(name).where('atmId', '==', id).get();
      for (const record of records.docs) await record.ref.delete();
    }
    const ref = db.collection('atms').doc(id);
    const requests = await ref.collection('requests').get();
    for (const record of requests.docs) await record.ref.delete();
    await ref.delete();
  }
  await db.terminate();
});
test('real ATM APIs require device/screen authority, origin and single-use pairing', async () => {
  assert.equal((await request(`/api/atm/${fixture}`)).status, 401);
  assert.equal((await request(`/api/controller/${fixture}/pairing`, { method: 'POST', token: '0'.repeat(64), body: {} })).status, 401);
  assert.equal((await request(`/api/atm/${fixture}/pair`, { method: 'POST', body: { code: usedPairCode } })).status, 401);
  assert.equal((await request(`/api/atm/${fixture}`, { screen: otherCookie })).status, 401);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, requestOrigin: 'https://other.invalid', body: { mode: 'cash', requestId: randomUUID() },
  })).status, 403);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'cash', requestId: randomUUID(), templeId: 'temple-02' },
  })).status, 400);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'crypto', requestId: randomUUID() },
  })).status, 409);
});
test('real Firestore serializes ATM reception creation and restores the same request after reload', async () => {
  const requestId = randomUUID();
  const results = await Promise.all([requestId, randomUUID()].map((id) => request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'cash', requestId: id },
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.findIndex((result) => result.status === 201);
  const state = await results[winner].json();
  visit = state.visit;
  assert.equal(visit.state, 'awaiting_wallet');
  assert.equal(visit.cashAcceptanceEnabled, false);
  assert.equal(visit.cashLimitPaise, '50000');
  assert.equal(visit.templeId, 'temple-01');
  assert.ok(visit.expiresAt > Date.now() && visit.expiresAt <= Date.now() + 120000);
  const stored = await db.collection('visits').doc(visit.id).get();
  assert.equal(stored.get('cashSessionId'), visit.cashSessionId);
  const creation = await db.collection('atms').doc(fixture).collection('requests').where('visitId', '==', visit.id).get();
  const replay = await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'cash', requestId: creation.docs[0].id },
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).visit.id, visit.id);
  const reload = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(reload.visit.id, visit.id);
  if (origin.startsWith('https:')) {
    assert.equal(reload.deepLink, `https://link.metamask.io/dapp/${origin.slice(8)}/temples/temple-01?visit=${visit.id}`);
  } else {
    assert.equal(reload.deepLink, null);
    assert.match(reload.qrUnavailableReason, /HTTPS/);
  }
  const publicView = await (await request(`/api/visits/${visit.id}?templeId=temple-01`)).json();
  assert.equal(publicView.linkedToYou, false);
  for (const key of ['ownerWallet', 'credentialHash', 'screenHash', 'signature']) assert.equal(publicView[key], undefined);
  assert.equal((await request(`/api/visits/${visit.id}?templeId=temple-02`)).status, 404);
  assert.equal((await request(`/api/atm/${second}/visits/${visit.id}/close`, { method: 'POST', screen: otherCookie, body: {} })).status, 403);
});
test('cash claims bind the signed reception, serialize competing owners and never start cash', async () => {
  const bodies = [];
  for (let index = 0; index < accounts.length; index++) {
    const result = await request(`/api/visits/${visit.id}/challenge`, { method: 'POST', token: tokens[index], body: { templeId: 'temple-01' } });
    assert.equal(result.status, 200);
    const challenge = await result.json();
    for (const binding of [fixture, visit.id, visit.cashSessionId, 'temple-01', 'Chain ID: 84532', new URL(origin).host]) {
      assert.ok(challenge.message.includes(binding), `missing reception binding ${binding}`);
    }
    bodies.push({ templeId: 'temple-01', nonce: challenge.nonce, signature: await accounts[index].signMessage({ message: challenge.message }), consent: true });
  }
  assert.equal((await request(`/api/visits/${visit.id}/claim`, { method: 'POST', token: tokens[1], body: bodies[0] })).status, 403);
  assert.equal((await request(`/api/visits/${visit.id}/claim`, { method: 'POST', token: tokens[0], body: { ...bodies[0], consent: false } })).status, 400);
  const results = await Promise.all(bodies.map((body, index) => request(`/api/visits/${visit.id}/claim`, {
    method: 'POST', token: tokens[index], body,
  })));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  const winner = results.findIndex((response) => response.status === 200);
  const duplicate = await request(`/api/visits/${visit.id}/claim`, { method: 'POST', token: tokens[winner], body: bodies[winner] });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).linkedToYou, true);
  assert.equal((await request(`/api/visits/${visit.id}/mine?templeId=temple-01`, { token: tokens[1 - winner] })).status, 403);
  const stored = await db.collection('visits').doc(visit.id).get();
  assert.equal(stored.get('state'), 'linked');
  assert.equal(stored.get('ownerWallet'), accounts[winner].address);
  assert.equal(stored.get('commandId'), undefined);
  assert.equal(stored.get('donationId'), undefined);
  assert.equal((await request(`/api/atm/${fixture}/visits/${visit.id}/close`, { method: 'POST', screen: cookie, body: {} })).status, 200);
  assert.equal((await db.collection('visits').doc(visit.id).get()).get('state'), 'closed');
});
test('expired QR cannot be claimed, and a fresh QR never reuses or deletes its reception', async () => {
  const response = await request(`/api/atm/${fixture}/visits`, { method: 'POST', screen: cookie, body: { mode: 'cash', requestId: randomUUID() } });
  assert.equal(response.status, 201);
  const expired = (await response.json()).visit;
  await db.collection('visits').doc(expired.id).update({ expiresAt: Date.now() - 1 });
  assert.equal((await request(`/api/visits/${expired.id}/challenge`, {
    method: 'POST', token: tokens[0], body: { templeId: 'temple-01' },
  })).status, 409);
  const next = await request(`/api/atm/${fixture}/visits`, { method: 'POST', screen: cookie, body: { mode: 'cash', requestId: randomUUID() } });
  assert.equal(next.status, 201);
  const fresh = (await next.json()).visit;
  assert.notEqual(fresh.id, expired.id);
  assert.equal((await db.collection('visits').doc(expired.id).get()).get('state'), 'expired');
  assert.equal((await request(`/api/atm/${fixture}/visits/${fresh.id}/close`, { method: 'POST', screen: cookie, body: {} })).status, 200);
});
