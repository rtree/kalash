import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { ATM_ID, CASH_LIMIT_PAISE, VISIT_REFERENCE, VISIT_TTL_MS, metaMaskLink, templeTarget, visitState, type AtmDto, type VisitDto, type VisitState } from '../atm.ts';
import { CHAIN_ID } from '../shared.ts';
import { db, origin } from './config.ts';
import { temples } from './catalog.ts';
import { requireValue } from './errors.ts';

const SCREEN_TTL_MS = 8 * 60 * 60 * 1000;
const PAIR_TTL_MS = 120_000;
export const SCREEN_COOKIE = 'kalash_atm';
export const credentialHash = (value: string) => createHash('sha256').update(value).digest('hex');
interface AtmRecord {
  id: string;
  name: string;
  templeId: string;
  enabled: boolean;
  credentialHash: string;
  activeVisitId?: string | null;
  screenHash?: string;
  screenExpiresAt?: number;
}
interface VisitRecord {
  id: string;
  atmId: string;
  templeId: string;
  mode: 'cash';
  state: VisitState;
  expiresAt: number;
  cashSessionId: string;
  ownerWallet?: Address;
  commandId?: string;
}
function atmReference(id: unknown) {
  requireValue(typeof id === 'string' && ATM_ID.test(id), 400, 'INVALID_ATM', 'Invalid ATM reference.');
  return db.collection('atms').doc(id);
}
function visitReference(id: unknown) {
  requireValue(typeof id === 'string' && VISIT_REFERENCE.test(id), 400, 'INVALID_VISIT', 'Invalid reception reference.');
  return db.collection('visits').doc(id);
}
function validAtm(data: AtmRecord | undefined): AtmRecord {
  requireValue(data?.enabled && temples.some((item) => item.id === data.templeId && item.onsite),
    403, 'ATM_UNAVAILABLE', 'This ATM is not registered for onsite reception.');
  return data;
}
function screenCredential(cookie: string | undefined) {
  const value = cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SCREEN_COOKIE}=`))?.slice(SCREEN_COOKIE.length + 1);
  requireValue(value && VISIT_REFERENCE.test(value), 401, 'ATM_PAIRING_REQUIRED', 'Pair this screen from the registered Controller.');
  return credentialHash(value);
}
function validScreen(data: AtmRecord | undefined, hash: string): AtmRecord {
  const atm = validAtm(data);
  requireValue(atm.screenHash === hash && (atm.screenExpiresAt ?? 0) > Date.now(),
    401, 'ATM_PAIRING_REQUIRED', 'Screen authorization expired. Pair it from the registered Controller.');
  return atm;
}
function dto(visit: VisitRecord, atm: AtmRecord): VisitDto {
  return {
    id: visit.id, templeId: visit.templeId, templeName: temples.find((item) => item.id === visit.templeId)!.name,
    atmId: atm.id, atmName: atm.name, mode: visit.mode, state: visitState(visit.state, visit.expiresAt, Date.now()),
    expiresAt: visit.expiresAt, cashSessionId: visit.cashSessionId,
    cashAcceptanceEnabled: false, cashLimitPaise: CASH_LIMIT_PAISE,
  };
}
function unclaimed(visit: VisitRecord, atm: AtmRecord) {
  requireValue(atm.activeVisitId === visit.id && atm.templeId === visit.templeId
    && visitState(visit.state, visit.expiresAt, Date.now()) === 'awaiting_wallet',
    409, 'VISIT_NOT_OPEN', 'This reception is expired, closed or already linked. Check the ATM.');
}
export async function createPairing(atmId: string, authorization: string | undefined) {
  const ref = atmReference(atmId);
  const atm = validAtm((await ref.get()).data() as AtmRecord | undefined);
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  requireValue(token && credentialHash(token) === atm.credentialHash,
    401, 'CONTROLLER_AUTH_REQUIRED', 'A registered Controller credential is required.');
  const code = randomBytes(8).toString('hex');
  await db.collection('atmPairings').doc(credentialHash(code)).create({
    atmId, credentialHash: atm.credentialHash, expiresAt: Date.now() + PAIR_TTL_MS, used: false,
  });
  return { code, expiresInSeconds: PAIR_TTL_MS / 1000 };
}
export async function pairScreen(atmId: string, code: unknown) {
  requireValue(typeof code === 'string' && /^[a-f0-9]{16}$/.test(code),
    400, 'INVALID_PAIRING_CODE', 'Enter the current 16-character screen pairing code.');
  const token = randomBytes(32).toString('hex');
  const atmRef = atmReference(atmId);
  const pairRef = db.collection('atmPairings').doc(credentialHash(code));
  await db.runTransaction(async (tx) => {
    const [atmSnapshot, pairSnapshot] = await Promise.all([tx.get(atmRef), tx.get(pairRef)]);
    const atm = validAtm(atmSnapshot.data() as AtmRecord | undefined);
    const pair = pairSnapshot.data();
    requireValue(pair && pair.atmId === atmId && pair.credentialHash === atm.credentialHash
      && !pair.used && pair.expiresAt > Date.now(), 401, 'PAIRING_EXPIRED', 'Pairing code expired or already used.');
    tx.update(pairRef, { used: true, usedAt: Date.now() });
    tx.update(atmRef, { screenHash: credentialHash(token), screenExpiresAt: Date.now() + SCREEN_TTL_MS });
  });
  return `${SCREEN_COOKIE}=${token}; Path=/api/atm/${atmId}; HttpOnly; SameSite=Strict; Max-Age=${SCREEN_TTL_MS / 1000}${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function getAtm(atmId: string, cookie: string | undefined): Promise<AtmDto> {
  const atm = validScreen((await atmReference(atmId).get()).data() as AtmRecord | undefined, screenCredential(cookie));
  const visit = atm.activeVisitId ? (await visitReference(atm.activeVisitId).get()).data() as VisitRecord | undefined : undefined;
  requireValue(!atm.activeVisitId || (visit && visit.atmId === atm.id && visit.templeId === atm.templeId),
    409, 'ATM_RECONCILIATION_REQUIRED', 'The active reception needs reconciliation.');
  const view = visit ? dto(visit, atm) : null;
  const qrUnavailableReason = view?.state === 'awaiting_wallet' && new URL(origin).protocol !== 'https:'
    ? 'QR handoff requires the deployed HTTPS site. Local reception tests do not provide a mobile QR.' : null;
  const targetUrl = view?.state === 'awaiting_wallet' && !qrUnavailableReason ? templeTarget(origin, atm.templeId, view.id) : null;
  return {
    id: atm.id, name: atm.name, templeId: atm.templeId, templeName: temples.find((item) => item.id === atm.templeId)!.name,
    visit: view, targetUrl, deepLink: targetUrl ? metaMaskLink(targetUrl, origin) : null, qrUnavailableReason,
    cashAcceptanceEnabled: false, cryptoDonationEnabled: false,
  };
}
export async function createVisit(atmId: string, cookie: string | undefined, mode: unknown, requestId: unknown) {
  requireValue(mode === 'cash', 409, 'MODE_UNAVAILABLE', 'Onsite crypto will be enabled with the M5 payment integration.');
  requireValue(typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId),
    400, 'INVALID_REQUEST_ID', 'A stable reception request ID is required.');
  const screenHash = screenCredential(cookie);
  const atmRef = atmReference(atmId);
  const requestRef = atmRef.collection('requests').doc(requestId);
  const id = randomBytes(32).toString('hex');
  const newRef = visitReference(id);
  const cashSessionId = randomUUID();
  await db.runTransaction(async (tx) => {
    const [atmSnapshot, existingRequest] = await Promise.all([tx.get(atmRef), tx.get(requestRef)]);
    const atm = validScreen(atmSnapshot.data() as AtmRecord | undefined, screenHash);
    if (existingRequest.exists) {
      requireValue(existingRequest.get('visitId') === atm.activeVisitId, 409, 'VISIT_REQUEST_CLOSED',
        'This request belongs to an older reception. Restore the current screen state.');
      return;
    }
    const activeRef = atm.activeVisitId ? visitReference(atm.activeVisitId) : null;
    const active = activeRef ? (await tx.get(activeRef)).data() as VisitRecord | undefined : undefined;
    if (activeRef) {
      requireValue(active && active.atmId === atm.id && active.templeId === atm.templeId
        && visitState(active.state, active.expiresAt, Date.now()) === 'expired' && !active.commandId,
      409, 'ATM_BUSY', 'This ATM already has a reception. Restore it rather than creating another.');
      tx.update(activeRef, { state: 'expired', closedAt: Date.now() });
    }
    const visit: VisitRecord = {
      id, atmId, templeId: atm.templeId, mode, state: 'awaiting_wallet',
      expiresAt: Date.now() + VISIT_TTL_MS, cashSessionId,
    };
    tx.create(newRef, { ...visit, createdAt: Date.now() });
    tx.create(requestRef, { visitId: id });
    tx.update(atmRef, { activeVisitId: id });
  });
  return getAtm(atmId, cookie);
}
export async function closeVisit(atmId: string, cookie: string | undefined, id: string) {
  const hash = screenCredential(cookie);
  const atmRef = atmReference(atmId);
  const visitRef = visitReference(id);
  await db.runTransaction(async (tx) => {
    const [atmSnapshot, visitSnapshot] = await Promise.all([tx.get(atmRef), tx.get(visitRef)]);
    const atm = validScreen(atmSnapshot.data() as AtmRecord | undefined, hash);
    const visit = visitSnapshot.data() as VisitRecord | undefined;
    requireValue(visit && visit.atmId === atm.id && visit.templeId === atm.templeId,
      403, 'WRONG_ATM', 'This reception belongs to another ATM.');
    if (visit.state === 'closed') return;
    requireValue(atm.activeVisitId === id && !visit.commandId
      && ['awaiting_wallet', 'linked', 'expired'].includes(visit.state),
    409, 'RECONCILIATION_REQUIRED', 'A started cash operation cannot be closed from reception.');
    tx.update(visitRef, { state: 'closed', closedAt: Date.now() });
    tx.update(atmRef, { activeVisitId: null });
  });
  return getAtm(atmId, cookie);
}
export async function getVisit(id: string, templeId: string, owner?: Address) {
  const visit = (await visitReference(id).get()).data() as VisitRecord | undefined;
  requireValue(visit && visit.templeId === templeId, 404, 'VISIT_NOT_FOUND', 'Reception not found for this temple.');
  const atm = validAtm((await atmReference(visit.atmId).get()).data() as AtmRecord | undefined);
  requireValue(atm.templeId === visit.templeId, 409, 'VISIT_MISMATCH', 'The reception configuration changed.');
  if (owner && visit.ownerWallet) {
    requireValue(visit.ownerWallet.toLowerCase() === owner.toLowerCase(),
      403, 'VISIT_NOT_OWNER', 'This reception is linked to another wallet.');
  }
  return { ...dto(visit, atm), linkedToYou: Boolean(owner && visit.ownerWallet?.toLowerCase() === owner.toLowerCase()) };
}
export async function visitChallenge(id: string, templeId: unknown, owner: Address) {
  requireValue(typeof templeId === 'string', 400, 'TEMPLE_REQUIRED', 'Confirm the reception temple.');
  const visit = (await visitReference(id).get()).data() as VisitRecord | undefined;
  requireValue(visit && visit.templeId === templeId, 404, 'VISIT_NOT_FOUND', 'Reception not found for this temple.');
  const atm = validAtm((await atmReference(visit.atmId).get()).data() as AtmRecord | undefined);
  unclaimed(visit, atm);
  const nonce = randomBytes(24).toString('hex');
  const url = new URL(origin);
  const message = createSiweMessage({
    address: owner, chainId: CHAIN_ID, domain: url.host, uri: url.origin, version: '1', nonce,
    issuedAt: new Date(), expirationTime: new Date(visit.expiresAt),
    statement: `Link my wallet to cash reception ${visit.cashSessionId} at ${visit.templeId}, ATM ${visit.atmId}. This is reception consent, not a token transfer. Cash acceptance is not enabled.`,
    resources: [`${url.origin}/temples/${visit.templeId}?visit=${visit.id}`],
  });
  await db.collection('visitChallenges').doc(nonce).create({
    visitId: id, templeId, atmId: visit.atmId, cashSessionId: visit.cashSessionId,
    ownerWallet: owner, message, expiresAt: visit.expiresAt, used: false,
  });
  return { nonce, message };
}
export async function claimVisit(id: string, owner: Address, body: Record<string, unknown>) {
  const { templeId, nonce, signature, consent } = body;
  requireValue(consent === true && typeof templeId === 'string' && typeof nonce === 'string'
    && /^[a-f0-9]{48}$/.test(nonce) && typeof signature === 'string' && /^0x[0-9a-f]{130}$/i.test(signature),
  400, 'VISIT_CONSENT_REQUIRED', 'Explicit reception consent and its wallet signature are required.');
  const challengeRef = db.collection('visitChallenges').doc(nonce);
  const challenge = (await challengeRef.get()).data();
  requireValue(challenge && challenge.visitId === id && challenge.templeId === templeId
    && challenge.ownerWallet.toLowerCase() === owner.toLowerCase(),
  403, 'VISIT_SIGNATURE_MISMATCH', 'This signature challenge belongs to another reception or wallet.');
  requireValue(await verifyMessage({ address: owner, message: challenge.message, signature: signature as Hex }),
    401, 'SIGNATURE_INVALID', 'Wallet signature does not match the reception.');
  const ref = visitReference(id);
  const atmRef = atmReference(challenge.atmId);
  await db.runTransaction(async (tx) => {
    const [visitSnapshot, challengeSnapshot, atmSnapshot] = await Promise.all([tx.get(ref), tx.get(challengeRef), tx.get(atmRef)]);
    const visit = visitSnapshot.data() as VisitRecord | undefined;
    const current = challengeSnapshot.data();
    const atm = validAtm(atmSnapshot.data() as AtmRecord | undefined);
    requireValue(visit && visit.atmId === atm.id && visit.templeId === templeId
      && visit.cashSessionId === challenge.cashSessionId, 409, 'VISIT_MISMATCH', 'Reception binding changed.');
    if (visit.state === 'linked' && visit.ownerWallet?.toLowerCase() === owner.toLowerCase()
      && current?.used && current.visitId === id) return;
    unclaimed(visit, atm);
    requireValue(current && !current.used && current.expiresAt > Date.now(),
      401, 'VISIT_CHALLENGE_EXPIRED', 'Reception signature expired or was already used.');
    tx.update(challengeRef, { used: true, usedAt: Date.now() });
    tx.update(ref, { state: 'linked', ownerWallet: owner, linkedAt: Date.now(), consentVersion: 'cash-reception-v1' });
  });
  return getVisit(id, templeId, owner);
}
