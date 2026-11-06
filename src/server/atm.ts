import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { ATM_ID, CASH_LIMIT_PAISE, VISIT_REFERENCE, VISIT_TTL_MS, cashMachineStatus, metaMaskLink, templeTarget, visitState, type AtmDto, type CashMachineStatus, type VisitDto, type VisitState } from '../atm.ts';
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
  controllerHealth?: ControllerHealth;
}
interface VisitRecord {
  id: string;
  atmId: string;
  templeId: string;
  mode: 'crypto';
  state: VisitState;
  expiresAt: number;
  cashSessionId: null;
  ownerWallet?: Address;
  donationId?: string;
  linkedAt?: number;
}
interface ControllerHealth {
  sequence: number;
  receivedAt: number;
  usbConnected: boolean;
  connectionOpen: boolean;
  deviceStarted: boolean;
  routesVerified: boolean;
  pollerOwned: boolean;
  deviceId: string | null;
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
function dto(visit: VisitRecord, atm: AtmRecord, donationStatus?: string): VisitDto {
  const donationState = !visit.donationId ? null
    : donationStatus === 'confirmed' ? 'confirmed'
      : ['failed', 'expired', 'cancelled'].includes(donationStatus ?? '') ? 'failed' : 'pending';
  return {
    id: visit.id, templeId: visit.templeId, templeName: temples.find((item) => item.id === visit.templeId)!.name,
    atmId: atm.id, atmName: atm.name, mode: visit.mode, state: visitState(visit.state, visit.expiresAt, Date.now()),
    expiresAt: visit.expiresAt, cashSessionId: null,
    cashAcceptanceEnabled: false, cashLimitPaise: CASH_LIMIT_PAISE, donationState,
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
export async function reportControllerHealth(atmId: string, authorization: string | undefined, body: Record<string, unknown>) {
  const allowed = ['sequence', 'reportedAt', 'usbConnected', 'connectionOpen', 'deviceStarted', 'routesVerified', 'pollerOwned', 'deviceId'];
  requireValue(Object.keys(body).every((key) => allowed.includes(key))
    && Number.isSafeInteger(body.sequence) && Number(body.sequence) > 0
    && typeof body.reportedAt === 'number' && Math.abs(Date.now() - body.reportedAt) <= 30_000
    && typeof body.usbConnected === 'boolean' && typeof body.connectionOpen === 'boolean'
    && typeof body.deviceStarted === 'boolean' && typeof body.routesVerified === 'boolean'
    && typeof body.pollerOwned === 'boolean'
    && (body.deviceId === null || (typeof body.deviceId === 'string' && body.deviceId.length <= 128)),
  400, 'INVALID_CONTROLLER_HEALTH', 'A recent, sequenced read-only Controller health report is required.');
  const reference = atmReference(atmId);
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  requireValue(token, 401, 'CONTROLLER_AUTH_REQUIRED', 'A registered Controller credential is required.');
  let accepted = false;
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(reference);
    const atm = validAtm(snapshot.data() as AtmRecord | undefined);
    requireValue(credentialHash(token) === atm.credentialHash,
      401, 'CONTROLLER_AUTH_REQUIRED', 'A registered Controller credential is required.');
    const previous = atm.controllerHealth;
    const sequence = Number(body.sequence);
    if (previous && sequence <= previous.sequence) {
      if (sequence === previous.sequence
        && previous.usbConnected === body.usbConnected && previous.connectionOpen === body.connectionOpen
        && previous.deviceStarted === body.deviceStarted && previous.routesVerified === body.routesVerified
        && previous.pollerOwned === body.pollerOwned && previous.deviceId === body.deviceId) {
        accepted = true;
        return;
      }
      requireValue(false, 409, 'STALE_CONTROLLER_HEALTH', 'Controller health sequence is not newer than the stored report.');
    }
    tx.update(reference, {
      controllerHealth: {
        sequence, receivedAt: Date.now(), usbConnected: body.usbConnected,
        connectionOpen: body.connectionOpen, deviceStarted: body.deviceStarted,
        routesVerified: body.routesVerified, pollerOwned: body.pollerOwned, deviceId: body.deviceId,
      },
    });
    accepted = true;
  });
  return { accepted, cashEnabled: false, cashAcceptanceEnabled: false, cryptoEnabled: true };
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
  const atmRef = atmReference(atmId);
  let atm = validScreen((await atmRef.get()).data() as AtmRecord | undefined, screenCredential(cookie));
  let visit = atm.activeVisitId ? (await visitReference(atm.activeVisitId).get()).data() as VisitRecord | undefined : undefined;
  requireValue(!atm.activeVisitId || (visit && visit.atmId === atm.id && visit.templeId === atm.templeId),
    409, 'ATM_RECONCILIATION_REQUIRED', 'The active reception needs reconciliation.');
  if (visit?.state === 'donation_pending' && visit.donationId) {
    const settled = await settleConfirmedVisit(atmId, visit.id, visit.donationId);
    if (settled) {
      atm = validScreen((await atmRef.get()).data() as AtmRecord | undefined, screenCredential(cookie));
      visit = atm.activeVisitId ? (await visitReference(atm.activeVisitId).get()).data() as VisitRecord | undefined : undefined;
    }
  }
  const donation = visit?.donationId ? (await db.collection('donations').doc(visit.donationId).get()).data() : undefined;
  const view = visit ? dto(visit, atm, donation?.status) : null;
  const status = cashMachineStatus(atm.controllerHealth ?? null, Date.now());
  const cashDisabledReason = status === 'offline'
    ? 'Controller health is unavailable or stale. Cash is disabled; Crypto remains available.'
    : status === 'disconnected'
      ? 'NV200 is not USB-connected and ready. Cash is disabled; Crypto remains available.'
      : 'Cash collection is the next stage and is not enabled yet. Crypto is available.';
  const qrUnavailableReason = view?.state === 'awaiting_wallet' && new URL(origin).protocol !== 'https:'
    ? 'QR handoff requires the deployed HTTPS site. Local reception tests do not provide a mobile QR.' : null;
  const targetUrl = view?.state === 'awaiting_wallet' && !qrUnavailableReason ? templeTarget(origin, atm.templeId, view.id) : null;
  return {
    id: atm.id, name: atm.name, templeId: atm.templeId, templeName: temples.find((item) => item.id === atm.templeId)!.name,
    visit: view, targetUrl, deepLink: targetUrl ? metaMaskLink(targetUrl, origin) : null, qrUnavailableReason,
    cashMachineStatus: status, cashDisabledReason,
    cashAcceptanceEnabled: false, cryptoDonationEnabled: !view,
  };
}
export async function createVisit(atmId: string, cookie: string | undefined, mode: unknown, requestId: unknown) {
  requireValue(mode === 'crypto', 409, 'MODE_UNAVAILABLE', 'Cash reception is not enabled in the onsite Crypto phase.');
  requireValue(typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId),
    400, 'INVALID_REQUEST_ID', 'A stable reception request ID is required.');
  const screenHash = screenCredential(cookie);
  const atmRef = atmReference(atmId);
  const requestRef = atmRef.collection('requests').doc(requestId);
  const id = randomBytes(32).toString('hex');
  const newRef = visitReference(id);
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
        && visitState(active.state, active.expiresAt, Date.now()) === 'expired',
      409, 'ATM_BUSY', 'This ATM already has a reception. Restore it rather than creating another.');
      tx.update(activeRef, { state: 'expired', closedAt: Date.now() });
    }
    const visit: VisitRecord = {
      id, atmId, templeId: atm.templeId, mode, state: 'awaiting_wallet',
      expiresAt: Date.now() + VISIT_TTL_MS, cashSessionId: null,
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
    const donationSnapshot = visit.donationId
      ? await tx.get(db.collection('donations').doc(visit.donationId)) : undefined;
    requireValue(atm.activeVisitId === id
      && (['awaiting_wallet', 'linked', 'expired'].includes(visit.state)
        || (visit.state === 'donation_pending'
          && ['failed', 'expired', 'cancelled'].includes(donationSnapshot?.get('status') ?? ''))),
    409, 'RECONCILIATION_REQUIRED', 'A pending or unknown donation cannot be closed. Verify it first.');
    tx.update(visitRef, { state: 'closed', closedAt: Date.now() });
    tx.update(atmRef, { activeVisitId: null });
  });
  return getAtm(atmId, cookie);
}
export async function getVisit(id: string, templeId: string, owner?: Address) {
  let visit = (await visitReference(id).get()).data() as VisitRecord | undefined;
  requireValue(visit && visit.templeId === templeId, 404, 'VISIT_NOT_FOUND', 'Reception not found for this temple.');
  let atm = validAtm((await atmReference(visit.atmId).get()).data() as AtmRecord | undefined);
  requireValue(atm.templeId === visit.templeId, 409, 'VISIT_MISMATCH', 'The reception configuration changed.');
  if (visit.state === 'donation_pending' && visit.donationId
    && (await db.collection('donations').doc(visit.donationId).get()).get('status') === 'confirmed') {
    await settleConfirmedVisit(atm.id, visit.id, visit.donationId);
    visit = (await visitReference(id).get()).data() as VisitRecord | undefined;
    requireValue(visit, 404, 'VISIT_NOT_FOUND', 'Onsite reception could not be restored.');
    atm = validAtm((await atmReference(visit.atmId).get()).data() as AtmRecord | undefined);
  }
  if (owner && visit.ownerWallet) {
    requireValue(visit.ownerWallet.toLowerCase() === owner.toLowerCase(),
      403, 'VISIT_NOT_OWNER', 'This reception is linked to another wallet.');
  }
  const linkedToYou = Boolean(owner && visit.ownerWallet?.toLowerCase() === owner.toLowerCase());
  const donation = linkedToYou && visit.donationId
    ? (await db.collection('donations').doc(visit.donationId).get()).data() : undefined;
  return {
    ...dto(visit, atm, donation?.status), linkedToYou,
    ...(owner ? { donationId: linkedToYou ? visit.donationId ?? null : null } : {}),
  };
}
export async function claimVisit(id: string, owner: Address, templeId: unknown, consent: unknown) {
  requireValue(typeof templeId === 'string' && consent === true,
    400, 'VISIT_CONSENT_REQUIRED', 'Confirm this onsite Crypto reception before joining.');
  const ref = visitReference(id);
  const initial = (await ref.get()).data() as VisitRecord | undefined;
  requireValue(initial && initial.templeId === templeId && initial.mode === 'crypto',
    404, 'VISIT_NOT_FOUND', 'Onsite Crypto reception not found for this temple.');
  const atmRef = atmReference(initial.atmId);
  await db.runTransaction(async (tx) => {
    const [visitSnapshot, atmSnapshot] = await Promise.all([tx.get(ref), tx.get(atmRef)]);
    const visit = visitSnapshot.data() as VisitRecord | undefined;
    const atm = validAtm(atmSnapshot.data() as AtmRecord | undefined);
    requireValue(visit && visit.atmId === atm.id && visit.templeId === templeId && visit.mode === 'crypto',
      409, 'VISIT_MISMATCH', 'Onsite Crypto reception binding changed.');
    if (visit.state === 'linked' && visit.ownerWallet?.toLowerCase() === owner.toLowerCase()) return;
    unclaimed(visit, atm);
    tx.update(ref, { state: 'linked', ownerWallet: getAddress(owner), linkedAt: Date.now(), consentVersion: 'onsite-crypto-join-v1' });
  });
  return getVisit(id, templeId, owner);
}

async function settleConfirmedVisit(atmId: string, id: string, donationId: string): Promise<boolean> {
  const atmRef = atmReference(atmId);
  const visitRef = visitReference(id);
  const donationRef = db.collection('donations').doc(donationId);
  return db.runTransaction(async (tx) => {
    const [atmSnapshot, visitSnapshot, donationSnapshot] = await Promise.all([
      tx.get(atmRef), tx.get(visitRef), tx.get(donationRef),
    ]);
    const atm = atmSnapshot.data() as AtmRecord | undefined;
    const visit = visitSnapshot.data() as VisitRecord | undefined;
    if (visit?.state !== 'donation_pending' || visit.donationId !== donationId
      || donationSnapshot.get('status') !== 'confirmed') return false;
    tx.update(visitRef, { state: 'confirmed', confirmedAt: Date.now() });
    if (atm?.activeVisitId === id) tx.update(atmRef, { activeVisitId: null });
    return true;
  });
}
