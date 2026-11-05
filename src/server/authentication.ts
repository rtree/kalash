import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { CHAIN_ID } from '../shared.ts';
import { auth, db, origin } from './config.ts';
import { requireValue } from './errors.ts';

export async function identity(header: string | undefined): Promise<Address> {
  requireValue(typeof header === 'string' && header.startsWith('Bearer '), 401, 'AUTH_REQUIRED', 'Sign in with your wallet.');
  const token = await auth.verifyIdToken(header.slice(7), true);
  requireValue(typeof token.wallet === 'string' && isAddress(token.wallet)
    && token.uid === `wallet_${token.wallet.toLowerCase()}`, 403, 'WALLET_REQUIRED', 'Verified wallet ownership is required.');
  return getAddress(token.wallet);
}
export async function challenge(wallet: unknown) {
  requireValue(typeof wallet === 'string' && isAddress(wallet), 400, 'INVALID_WALLET', 'A valid wallet is required.');
  const address = getAddress(wallet);
  const nonce = randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = now.getTime() + 300000;
  const url = new URL(origin);
  const message = createSiweMessage({
    address, chainId: CHAIN_ID, domain: url.host, uri: url.origin, version: '1',
    nonce, issuedAt: now, expirationTime: new Date(expiresAt),
    statement: 'Sign in to KALASH. This does not authorize a donation or token transfer.',
  });
  await db.collection('challenges').doc(nonce).create({
    wallet: address, message, origin: url.origin, expiresAt, used: false,
  });
  return { nonce, message };
}
export async function verifyChallenge(nonce: unknown, signature: unknown) {
  requireValue(typeof nonce === 'string' && /^[a-f0-9]{48}$/.test(nonce)
    && typeof signature === 'string' && /^0x[0-9a-f]+$/i.test(signature),
  400, 'INVALID_SIGNATURE_REQUEST', 'Invalid sign-in request.');
  const reference = db.collection('challenges').doc(nonce);
  const snapshot = await reference.get();
  const data = snapshot.data();
  requireValue(data && data.expiresAt > Date.now() && !data.used && data.origin === new URL(origin).origin,
    401, 'NONCE_EXPIRED', 'Sign-in challenge expired or already used.');
  const wallet = getAddress(data.wallet);
  requireValue(await verifyMessage({ address: wallet, message: data.message, signature: signature as Hex }),
    401, 'SIGNATURE_INVALID', 'Wallet signature does not match.');
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.get(reference)).data();
    requireValue(current && !current.used && current.expiresAt > Date.now(),
      401, 'NONCE_USED', 'Sign-in challenge expired or already used.');
    transaction.update(reference, { used: true, usedAt: new Date().toISOString() });
  });
  const customToken = await auth.createCustomToken(`wallet_${wallet.toLowerCase()}`, { wallet: wallet.toLowerCase() });
  return { customToken };
}
