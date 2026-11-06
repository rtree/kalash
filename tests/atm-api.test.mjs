import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { validateCashReadinessEvidence } from '../src/cash.ts';

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
let donationId;
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
      id, name: 'Isolated reception test', templeId: 'temple-01', enabled: true,
      cashEnabled: false, credentialHash: hash(credential),
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
    const visits = await db.collection('visits').where('atmId', '==', id).get();
    for (const record of visits.docs) {
      const requestRecords = await record.ref.collection('donationRequests').get();
      for (const request of requestRecords.docs) await request.ref.delete();
      const linkedDonation = record.get('donationId');
      if (linkedDonation) {
        const donation = db.collection('donations').doc(linkedDonation);
        const operations = await donation.collection('operations').get();
        for (const operation of operations.docs) await operation.ref.delete();
        await donation.delete();
      }
      await record.ref.delete();
    }
    const pairings = await db.collection('atmPairings').where('atmId', '==', id).get();
    for (const record of pairings.docs) await record.ref.delete();
    const commands = await db.collection('controllerCommands').where('atmId', '==', id).get();
    for (const record of commands.docs) await record.ref.delete();
    const cashChallenges = await db.collection('cashConsentChallenges').where('atmId', '==', id).get();
    for (const record of cashChallenges.docs) await record.ref.delete();
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
  const noHeartbeat = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(noHeartbeat.cashMachineStatus, 'offline');
  assert.equal(noHeartbeat.cashAcceptanceEnabled, false);
  assert.equal(noHeartbeat.cryptoDonationEnabled, true);
  assert.match(noHeartbeat.cashDisabledReason, /health is unavailable or stale/);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, requestOrigin: 'https://other.invalid', body: { mode: 'crypto', requestId: randomUUID() },
  })).status, 403);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'crypto', requestId: randomUUID(), templeId: 'temple-02' },
  })).status, 400);
  assert.equal((await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'cash', requestId: randomUUID() },
  })).status, 409);
  assert.equal((await request(`/api/controller/${fixture}/health`, {
    method: 'POST', body: { sequence: 1, reportedAt: Date.now(), usbConnected: false },
  })).status, 401);
  const health = {
    sequence: 1, reportedAt: Date.now(), usbConnected: false, connectionOpen: false,
    deviceStarted: false, routesVerified: false, pollerOwned: true, deviceId: null,
  };
  assert.equal((await request(`/api/controller/${fixture}/health`, {
    method: 'POST', token: credential, body: health,
  })).status, 200);
  assert.equal((await request(`/api/controller/${fixture}/health`, {
    method: 'POST', token: credential, body: health,
  })).status, 200, 'a retried health report is idempotent');
  assert.equal((await request(`/api/controller/${fixture}/health`, {
    method: 'POST', token: credential, body: { ...health, sequence: 1, usbConnected: true },
  })).status, 409, 'an older contradictory health report cannot overwrite the latest state');
  const status = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(status.cashMachineStatus, 'disconnected');
  assert.equal(status.cashAcceptanceEnabled, false);
  assert.equal(status.cryptoDonationEnabled, true);
  assert.match(status.cashDisabledReason, /Crypto remains available/);
  await db.collection('atms').doc(fixture).update({ 'controllerHealth.receivedAt': Date.now() - 16000 });
  const stale = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(stale.cashMachineStatus, 'offline');
  assert.equal(stale.cashAcceptanceEnabled, false);
  assert.equal(stale.cryptoDonationEnabled, true);
  const ready = await request(`/api/controller/${fixture}/health`, {
    method: 'POST', token: credential, body: {
      sequence: 2, reportedAt: Date.now(), usbConnected: true, connectionOpen: true,
      deviceStarted: true, routesVerified: true, pollerOwned: true, deviceId: 'test-device',
    },
  });
  assert.equal(ready.status, 200);
  const readyState = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(readyState.cashMachineStatus, 'ready');
  assert.equal(readyState.cashAcceptanceEnabled, false, 'M5a never enables cash even when device health is ready');
  assert.equal(readyState.cryptoDonationEnabled, true);
});
test('real Firestore serializes Crypto reception creation, QR restoration and expiry', async () => {
  const unplugged = await request(`/api/controller/${fixture}/health`, {
    method: 'POST', token: credential, body: {
      sequence: 3, reportedAt: Date.now(), usbConnected: false, connectionOpen: false,
      deviceStarted: false, routesVerified: false, pollerOwned: true, deviceId: null,
    },
  });
  assert.equal(unplugged.status, 200);
  const requestIds = [randomUUID(), randomUUID()];
  const results = await Promise.all(requestIds.map((requestId) => request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'crypto', requestId },
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.findIndex((result) => result.status === 201);
  const state = await results[winner].json();
  visit = state.visit;
  assert.equal(visit.state, 'awaiting_wallet');
  assert.equal(visit.mode, 'crypto');
  assert.equal(visit.cashAcceptanceEnabled, false);
  assert.equal(visit.cashLimitPaise, '40000');
  assert.equal(visit.templeId, 'temple-01');
  assert.equal(state.cryptoDonationEnabled, false);
  assert.equal(state.cashMachineStatus, 'disconnected');
  assert.ok(visit.expiresAt > Date.now() && visit.expiresAt <= Date.now() + 120000);
  const stored = await db.collection('visits').doc(visit.id).get();
  assert.equal(stored.get('cashSessionId'), null);
  const creation = await db.collection('atms').doc(fixture).collection('requests').where('visitId', '==', visit.id).get();
  const replay = await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'crypto', requestId: creation.docs[0].id },
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
  await db.collection('visits').doc(visit.id).update({ expiresAt: Date.now() - 1 });
  assert.equal((await request(`/api/visits/${visit.id}/claim`, {
    method: 'POST', token: tokens[0], body: { templeId: 'temple-01', consent: true },
  })).status, 409);
  const next = await request(`/api/atm/${fixture}/visits`, {
    method: 'POST', screen: cookie, body: { mode: 'crypto', requestId: randomUUID() },
  });
  assert.equal(next.status, 201);
  const fresh = (await next.json()).visit;
  assert.notEqual(fresh.id, visit.id);
  assert.equal((await db.collection('visits').doc(visit.id).get()).get('state'), 'expired');
  visit = fresh;
});
test('onsite Crypto claim and intent bind the authenticated wallet and never enable Cash', async () => {
  const bodies = [];
  for (let index = 0; index < accounts.length; index++) {
    bodies.push({ templeId: 'temple-01', consent: true });
  }
  assert.equal((await request(`/api/visits/${visit.id}/claim`, {
    method: 'POST', token: tokens[0], body: { templeId: 'temple-02', consent: true },
  })).status, 404);
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
  assert.equal((await request('/api/donations', {
    method: 'POST', token: tokens[winner], body: { templeId: 'temple-01', amount: '0.01', kind: 1, visitId: visit.id },
  })).status, 400, 'remote API never allows a caller to self-select onsite kind');
  const requestId = randomUUID();
  const create = () => request(`/api/visits/${visit.id}/donation`, {
    method: 'POST', token: tokens[winner], body: { amount: '0.01', requestId },
  });
  const [first, concurrent] = await Promise.all([create(), create()]);
  assert.equal(first.status, 201);
  assert.equal(concurrent.status, 201);
  const intent = await first.json();
  const replay = await concurrent.json();
  donationId = intent.id;
  assert.equal(intent.kind, 1);
  assert.equal(intent.onsiteVisitId, visit.id);
  assert.equal(intent.amount, '10000');
  assert.equal(intent.fee, '1');
  assert.equal(intent.net, '9999');
  assert.equal(replay.id, intent.id);
  assert.equal(intent.txHash, undefined, 'creating an intent does not submit a wallet transaction');
  assert.equal((await request(`/api/visits/${visit.id}/donation`, {
    method: 'POST', token: tokens[1 - winner], body: { amount: '0.01', requestId: randomUUID() },
  })).status, 403);
  assert.equal((await request(`/api/visits/${visit.id}/donation`, {
    method: 'POST', token: tokens[winner], body: { amount: '0.1', requestId: randomUUID() },
  })).status, 409);
  const stored = await db.collection('visits').doc(visit.id).get();
  assert.equal(stored.get('state'), 'donation_pending');
  assert.equal(stored.get('ownerWallet'), accounts[winner].address);
  assert.equal(stored.get('donationId'), intent.id);
  assert.equal((await db.collection('donations').doc(intent.id).get()).get('kind'), 1);
  const atm = await (await request(`/api/atm/${fixture}`, { screen: cookie })).json();
  assert.equal(atm.visit.state, 'donation_pending');
  assert.equal(atm.visit.donationState, 'pending');
  assert.equal(atm.cashAcceptanceEnabled, false);
  assert.equal(atm.cryptoDonationEnabled, false);
  assert.equal((await request(`/api/atm/${fixture}/visits/${visit.id}/close`, {
    method: 'POST', screen: cookie, body: {},
  })).status, 409, 'a registered donation cannot be abandoned from the ATM screen');
});

test('cash visit consent binds one wallet to one cashSession and never starts acceptance', async () => {
  const atmRef = db.collection('atms').doc(second);
  await atmRef.update({ cashEnabled: true });
  const health = await request(`/api/controller/${second}/health`, {
    method: 'POST', token: credential, body: {
      sequence: 1, reportedAt: Date.now(), usbConnected: true, connectionOpen: true,
      deviceStarted: true, routesVerified: true, pollerOwned: true, deviceId: 'synthetic-device',
    },
  });
  assert.equal(health.status, 200);
  const readyAtm = await (await request(`/api/atm/${second}`, { screen: otherCookie })).json();
  assert.equal(readyAtm.cashMachineStatus, 'ready');
  assert.equal(readyAtm.cashReceptionAvailable, true);
  assert.equal(readyAtm.cashAcceptanceEnabled, false);
  assert.deepEqual((await (await request(`/api/controller/${second}/commands`, {
    token: credential,
  })).json()).command, null, 'the Controller receives no command before a wallet consent exists');

  const created = await request(`/api/atm/${second}/visits`, {
    method: 'POST', screen: otherCookie, body: { mode: 'cash', requestId: randomUUID() },
  });
  assert.equal(created.status, 201);
  const createdState = await created.json();
  assert.equal(createdState.visit.mode, 'cash');
  assert.equal(createdState.visit.cashSessionId, null);
  assert.equal(createdState.cashAcceptanceEnabled, false);

  const publicView = await (await request(`/api/visits/${createdState.visit.id}?templeId=temple-01`)).json();
  assert.equal(publicView.cashSessionId, null, 'the cashSessionId is not public before owner authentication');
  const response = await request(`/api/visits/${createdState.visit.id}/cash-challenge`, {
    method: 'POST', token: tokens[0], body: { templeId: 'temple-01' },
  });
  assert.equal(response.status, 200);
  const challenge = await response.json();
  assert.match(challenge.message, /Cash session:/);
  assert.match(challenge.message, /Purpose: cash/);
  assert.equal(challenge.cashLimitPaise, '40000');
  const signature = await accounts[0].signMessage({ message: challenge.message });
  const claim = await request(`/api/visits/${createdState.visit.id}/cash-claim`, {
    method: 'POST', token: tokens[0],
    body: { templeId: 'temple-01', nonce: challenge.nonce, signature },
  });
  assert.equal(claim.status, 200);
  const linked = await claim.json();
  const cashSessionId = challenge.message.match(/Cash session: ([a-f0-9-]+)/)?.[1];
  assert.ok(cashSessionId);
  assert.equal(linked.mode, 'cash');
  assert.equal(linked.state, 'awaiting_device');
  assert.equal(linked.linkedToYou, true);
  assert.equal(linked.cashSessionId, cashSessionId);
  assert.equal(linked.cashAcceptanceEnabled, false, 'wallet consent alone must not start acceptance');
  const commandResponse = await request(`/api/controller/${second}/commands`, { token: credential });
  assert.equal(commandResponse.status, 200);
  const command = (await commandResponse.json()).command;
  assert.deepEqual(command, {
    commandId: `cash-start-${cashSessionId}`,
    type: 'start_cash',
    state: 'pending',
    atmId: second,
    visitId: createdState.visit.id,
    templeId: 'temple-01',
    cashSessionId,
    expiresAt: command.expiresAt,
    createdAt: command.createdAt,
  });
  assert.ok(command.expiresAt > Date.now());
  assert.equal((await request(`/api/controller/${second}/commands`, { token: '0'.repeat(64) })).status, 401);
  const redelivered = (await (await request(`/api/controller/${second}/commands`, {
    token: credential,
  })).json()).command;
  assert.deepEqual(redelivered, command, 'redelivery preserves the immutable command identity and expiry');
  const report = (state, extra = {}) => request(
    `/api/controller/${second}/commands/${command.commandId}`,
    { method: 'POST', token: credential, body: { commandId: command.commandId, state, ...extra } },
  );
  assert.equal((await report('received')).status, 200);
  assert.equal((await report('received')).status, 200, 'replayed state reports are idempotent');
  assert.equal((await report('dispatching')).status, 409, 'dispatch cannot skip validation');
  assert.equal((await report('validated')).status, 200);
  assert.equal((await report('dispatching')).status, 200);
  assert.equal((await report('observed', {
    observedAt: Date.now(), deviceState: 'TEST_OBSERVATION',
  })).status, 400, 'an arbitrary state must not activate cash');
  assert.equal((await report('observed', {
    observedAt: Date.now(), deviceState: 'IDLE',
  })).status, 400, 'bare IDLE is not proof of post-enable readiness');
  const idleObservedAt = Date.now();
  const inventory = {
    levels: ['1000', '2000', '5000', '10000', '20000', '50000']
      .map((valuePaise) => ({ valuePaise, payout: 0, cashbox: 0 })),
    counters: { stored: 0, stacked: 0, dispensed: 0, transferredToStack: 0 },
  };
  const fixtureDeviceId = (await db.collection('atms').doc(second).get()).get('controllerHealth.deviceId');
  const readinessEvidence = validateCashReadinessEvidence({
      version: 'itl-idle-after-enable-v1', commandId: command.commandId, cashSessionId,
      deviceId: fixtureDeviceId, disabledObservedAt: idleObservedAt - 3,
      enableDispatchedAt: idleObservedAt - 2, enableAcknowledgedAt: idleObservedAt - 1,
      idleObservedAt, disabledRawSequence: 1, rawSequence: 2, deviceStateCode: 5,
      manualEscrow: true, routesVerified: true, escrowEmpty: true, deviceHealthy: true,
      baseline: inventory, inventory,
  });
  const idleReport = await report('observed', {
    observedAt: idleObservedAt, deviceState: 'IDLE', readinessEvidence,
  });
  const idleResult = await idleReport.json();
  assert.equal(idleReport.status, 200, `Isolated IDLE proof: ${idleResult.code ?? 'accepted'} ${idleResult.message ?? ''}`);
  assert.equal((await report('reported')).status, 200);
  assert.equal((await report('reported')).status, 200, 'Central acknowledgements are idempotent');
  assert.deepEqual(
    (await (await request(`/api/controller/${second}/commands`, { token: credential })).json()).command,
    null,
    'reported commands are no longer offered for execution',
  );
  const storedCommand = await db.collection('controllerCommands').doc(command.commandId).get();
  assert.equal(storedCommand.get('state'), 'reported');
  assert.equal(storedCommand.get('cashSessionId'), cashSessionId);
  assert.equal((await request(`/api/visits/${createdState.visit.id}/cash-claim`, {
    method: 'POST', token: tokens[0],
    body: { templeId: 'temple-01', nonce: challenge.nonce, signature },
  })).status, 200, 'the same owner can idempotently restore the same cash session');
  assert.equal((await (await request(`/api/visits/${createdState.visit.id}/mine?templeId=temple-01`, {
    token: tokens[0],
  })).json()).cashSessionId, cashSessionId);
  assert.equal((await request(`/api/visits/${createdState.visit.id}/mine?templeId=temple-01`, {
    token: tokens[1],
  })).status, 403, 'another wallet cannot read the linked cash session');
  const screenState = await (await request(`/api/atm/${second}`, { screen: otherCookie })).json();
  assert.equal(screenState.cashAcceptanceEnabled, true, 'only a Controller-reported observed device state activates acceptance');
  const sessionResponse = await request(`/api/controller/${second}/cash-session`, { token: credential });
  assert.equal(sessionResponse.status, 200);
  const { session } = await sessionResponse.json();
  assert.equal(session.cashSessionId, cashSessionId);
  assert.equal(session.state, 'accepting');
  assert.equal(session.closeRequested, false);
  const done = await request(`/api/atm/${second}/visits/${createdState.visit.id}/done`, {
    method: 'POST', screen: otherCookie, body: {},
  });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).visit.state, 'closing');
  const stopped = await (await request(`/api/controller/${second}/cash-session`, { token: credential })).json();
  assert.equal(stopped.session.closeRequested, true);
  assert.equal(stopped.session.closeReason, 'done');
  assert.equal((await request(`/api/controller/${second}/cash-events`, {
    method: 'POST', token: '0'.repeat(64), body: {},
  })).status, 401, 'deployed event route enforces Controller authentication');
  assert.equal((await request(`/api/controller/${second}/cash-events`, {
    method: 'POST', token: credential, body: {},
  })).status, 400, 'deployed event route rejects missing evidence rather than fabricating a note');
});
