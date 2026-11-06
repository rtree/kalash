import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPolicy } from './check-policy.mjs';

checkPolicy();
if (!process.env.LOCALAPPDATA) throw new Error('Run pairing on the registered Windows Controller.');
const directory = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets');
const credential = JSON.parse(readFileSync(join(directory, 'atm-01.json'), 'utf8'));
if (credential.atmId !== 'atm-01' || new URL(credential.origin).protocol !== 'https:'
  || !/^[a-f0-9]{64}$/.test(credential.token)) throw new Error('Invalid ATM credential/configuration.');
const response = await fetch(`${credential.origin}/api/controller/${credential.atmId}/pairing`, {
  method: 'POST', signal: AbortSignal.timeout(15000),
  headers: { Origin: credential.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${credential.token}` },
  body: '{}',
});
if (!response.ok) throw new Error(`Controller pairing failed (HTTP ${response.status}). No device command was issued.`);
const pairing = await response.json();
if (!/^[a-f0-9]{16}$/.test(pairing.code)) throw new Error('Invalid pairing response.');
const file = join(directory, 'atm-01-pairing.json');
writeFileSync(file, JSON.stringify({ code: pairing.code, expiresAt: new Date(Date.now() + pairing.expiresInSeconds * 1000).toISOString() }), { mode: 0o600 });
console.log(`Pairing code saved locally to ${file}. Enter it on /atm/atm-01 within 120 seconds. Do not share or commit this file.`);
