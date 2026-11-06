import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPolicy } from './check-policy.mjs';

checkPolicy();
const { initializeApp, applicationDefault } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
if (!process.env.LOCALAPPDATA) throw new Error('Provision the ATM on its Windows Controller host.');
const directory = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets');
if (!existsSync(directory)) throw new Error('Prepare an ACL-protected KALASH secrets directory first.');
const origin = process.env.PUBLIC_ORIGIN;
if (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') {
  throw new Error('PUBLIC_ORIGIN must be the canonical deployed HTTPS origin.');
}
initializeApp({ credential: applicationDefault(), projectId: 'kalash-donation' });
const db = getFirestore();
const id = 'atm-01';
const file = join(directory, `${id}.json`);
const reference = db.collection('atms').doc(id);
try {
  const current = await reference.get();
  if (current.exists && !existsSync(file)) throw new Error('ATM is already registered; recover its credential rather than replacing it.');
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({ atmId: id, origin, token: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
  }
  const credential = JSON.parse(readFileSync(file, 'utf8'));
  if (credential.atmId !== id || credential.origin !== origin || !/^[a-f0-9]{64}$/.test(credential.token)) {
    throw new Error('Stored ATM credential/configuration does not match.');
  }
  const hash = createHash('sha256').update(credential.token).digest('hex');
  await db.runTransaction(async (tx) => {
    const record = await tx.get(reference);
    if (record.exists) {
      if (record.get('credentialHash') !== hash || record.get('templeId') !== 'temple-01') {
        throw new Error('ATM registration mismatch; bootstrap will not overwrite it.');
      }
    } else {
      tx.create(reference, {
        id, name: 'Lotus Courtyard ATM', templeId: 'temple-01',
        enabled: true, credentialHash: hash, createdAt: new Date().toISOString(),
      });
    }
  });
  console.log('Registered atm-01 without changing existing receptions. Cash acceptance is not enabled.');
} finally {
  await db.terminate();
}
