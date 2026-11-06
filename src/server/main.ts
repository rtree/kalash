import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { CHAIN_ID, USDC, type Donation } from '../shared.ts';
import { db, origin, publicConfig, project } from './config.ts';
import { challenge, identity, verifyChallenge } from './authentication.ts';
import { temples } from './catalog.ts';
import {
  createDonation, ownedDonation, recordOperation, resolveApprovalOnlyIntent, verifyDonation,
} from './donations.ts';
import { HttpError, requireValue } from './errors.ts';
import { mintTick } from './mint.ts';
import { claimVisit, closeVisit, createPairing, createVisit, getAtm, getVisit, pairScreen, visitChallenge } from './atm.ts';
import {
  cleanupPhotoLifecycle, getBoardPhoto, getPhotoEligibility, listBoardPhotos, listOwnedPhotos,
  uploadPhoto, withdrawPhoto,
} from './photos.ts';

const rates = new Map<string, { started: number; count: number }>();
function rateLimit(request: IncomingMessage, key: string, maximum = 60) {
  const bucket = `${request.socket.remoteAddress}:${key}`;
  const current = rates.get(bucket);
  if (!current || Date.now() - current.started > 60000) {
    rates.set(bucket, { started: Date.now(), count: 1 });
    return;
  }
  requireValue(++current.count <= maximum, 429, 'RATE_LIMITED', 'Too many requests. Wait a minute before retrying.');
}
async function jsonBody(request: IncomingMessage, maximumBytes = 16384): Promise<Record<string, unknown>> {
  requireValue(request.headers['content-type']?.split(';')[0] === 'application/json',
    415, 'JSON_REQUIRED', 'Send application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size <= maximumBytes, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Invalid JSON body.');
  }
  requireValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'INVALID_BODY', 'Expected a JSON object.');
  return parsed as Record<string, unknown>;
}
function send(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function headers(response: ServerResponse) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.walletconnect.com https://*.reown.com https://*.web3modal.org https://tile.openstreetmap.org",
    "font-src 'self' https://fonts.reown.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com https://sepolia.base.org https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org https://*.reown.com https://*.web3modal.org",
    "frame-src 'self' https://*.firebaseapp.com https://verify.walletconnect.com https://verify.walletconnect.org",
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
  ].join('; '));
}
const publicRoot = resolve('dist/public');
async function staticFile(pathname: string, response: ServerResponse) {
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  const path = resolve(publicRoot, `.${decodeURIComponent(pathname)}`);
  requireValue(path === publicRoot || path.startsWith(publicRoot + sep), 400, 'INVALID_PATH', 'Invalid path.');
  const file = extname(pathname) ? path : resolve(publicRoot, 'index.html');
  let bytes: Buffer;
  try { bytes = await readFile(file); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new HttpError(404, 'FILE_NOT_FOUND', 'Build the web application before opening this page.');
    throw error;
  }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  response.writeHead(200, {
    'Content-Type': `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
    'Cache-Control': 'no-cache',
  });
  response.end(bytes);
}
const inflight = new Map<string, Promise<Donation>>();
async function handle(request: IncomingMessage, response: ServerResponse) {
  headers(response);
  const url = new URL(request.url ?? '/', origin);
  const path = url.pathname;
  if (!path.startsWith('/api/')) {
    requireValue(request.method === 'GET' || request.method === 'HEAD', 405, 'METHOD_NOT_ALLOWED', 'Only GET/HEAD is supported.');
    return staticFile(path, response);
  }
  rateLimit(request, path.startsWith('/api/auth/') ? 'auth' : 'api', path.startsWith('/api/auth/') ? 20 : 120);
  if (request.method === 'POST') {
    requireValue(request.headers.origin === new URL(origin).origin,
      403, 'ORIGIN_MISMATCH', 'Request origin does not match this KALASH deployment.');
  }
  if (request.method === 'GET' && path === '/api/health') return send(response, {
    status: 'ready', project, chainId: 84532, contractsDeployed: Boolean(publicConfig.vault),
    mintEnabled: process.env.MINT_ENABLED === 'true', sourceCommit: process.env.SOURCE_COMMIT ?? null,
  });
  if (request.method === 'GET' && path === '/api/config') return send(response, publicConfig);
  if (request.method === 'GET' && path === '/api/temples') return send(response, { temples });
  const boardMatch = path.match(/^\/api\/board\/([a-z0-9-]+)\/photos(?:\/([0-9a-f-]{36}))?$/i);
  if (request.method === 'GET' && boardMatch) {
    const templeId = boardMatch[1]!;
    if (!boardMatch[2]) return send(response, { photos: await listBoardPhotos(templeId) });
    const { data } = await getBoardPhoto(templeId, boardMatch[2]);
    response.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': data.length,
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.end(data);
    return;
  }
  if (request.method === 'POST' && path === '/api/auth/challenge') {
    const body = await jsonBody(request);
    return send(response, await challenge(body.wallet));
  }
  if (request.method === 'POST' && path === '/api/auth/verify') {
    const body = await jsonBody(request);
    return send(response, await verifyChallenge(body.nonce, body.signature));
  }
  const controllerPairing = path.match(/^\/api\/controller\/([a-z0-9-]+)\/pairing$/);
  if (request.method === 'POST' && controllerPairing) {
    rateLimit(request, 'atm-pairing', 10);
    const body = await jsonBody(request);
    requireValue(Object.keys(body).length === 0, 400, 'UNKNOWN_FIELD', 'Pairing takes no body fields.');
    return send(response, await createPairing(controllerPairing[1]!, request.headers.authorization));
  }
  const atmMatch = path.match(/^\/api\/atm\/([a-z0-9-]+)(?:\/(pair|visits)(?:\/([a-f0-9]{64})\/close)?)?$/);
  if (atmMatch) {
    const atmId = atmMatch[1]!;
    if (request.method === 'GET' && !atmMatch[2]) return send(response, await getAtm(atmId, request.headers.cookie));
    if (request.method === 'POST') {
      const body = await jsonBody(request);
      if (atmMatch[2] === 'pair' && !atmMatch[3]) {
        rateLimit(request, 'atm-pairing', 10);
        requireValue(Object.keys(body).every((key) => key === 'code'), 400, 'UNKNOWN_FIELD', 'Only a pairing code is accepted.');
        response.setHeader('Set-Cookie', await pairScreen(atmId, body.code));
        return send(response, { paired: true });
      }
      if (atmMatch[2] === 'visits' && !atmMatch[3]) {
        requireValue(Object.keys(body).every((key) => ['mode', 'requestId'].includes(key)),
          400, 'UNKNOWN_FIELD', 'Only reception mode and request ID are accepted.');
        return send(response, await createVisit(atmId, request.headers.cookie, body.mode, body.requestId), 201);
      }
      if (atmMatch[2] === 'visits' && atmMatch[3]) {
        requireValue(Object.keys(body).length === 0, 400, 'UNKNOWN_FIELD', 'Closing reception takes no body fields.');
        return send(response, await closeVisit(atmId, request.headers.cookie, atmMatch[3]));
      }
    }
  }
  const visitMatch = path.match(/^\/api\/visits\/([a-f0-9]{64})(?:\/(mine|challenge|claim))?$/);
  if (request.method === 'GET' && visitMatch && !visitMatch[2]) {
    return send(response, await getVisit(visitMatch[1]!, url.searchParams.get('templeId') ?? ''));
  }
  const owner = await identity(request.headers.authorization);
  rateLimit(request, owner.toLowerCase(), 100);
  if (visitMatch) {
    if (request.method === 'GET' && visitMatch[2] === 'mine') {
      return send(response, await getVisit(visitMatch[1]!, url.searchParams.get('templeId') ?? '', owner));
    }
    if (request.method === 'POST' && visitMatch[2] === 'challenge') {
      const body = await jsonBody(request);
      requireValue(Object.keys(body).every((key) => key === 'templeId'), 400, 'UNKNOWN_FIELD', 'Only the temple reference is accepted.');
      return send(response, await visitChallenge(visitMatch[1]!, body.templeId, owner));
    }
    if (request.method === 'POST' && visitMatch[2] === 'claim') {
      const body = await jsonBody(request);
      requireValue(Object.keys(body).every((key) => ['templeId', 'nonce', 'signature', 'consent'].includes(key)),
        400, 'UNKNOWN_FIELD', 'Only reception consent and its signature are accepted.');
      return send(response, await claimVisit(visitMatch[1]!, owner, body));
    }
  }
  const eligibilityMatch = path.match(/^\/api\/photos\/eligibility\/(0x[0-9a-f]{64})$/i);
  if (request.method === 'GET' && eligibilityMatch) {
    return send(response, await getPhotoEligibility(eligibilityMatch[1]!, owner));
  }
  if (request.method === 'GET' && path === '/api/photos/mine') {
    return send(response, { photos: await listOwnedPhotos(owner) });
  }
  if (request.method === 'POST' && path === '/api/photos') {
    const body = await jsonBody(request, 8_000_000);
    return send(response, await uploadPhoto(owner, body), 201);
  }
  const withdrawalMatch = path.match(/^\/api\/photos\/([0-9a-f-]{36})\/withdraw$/i);
  if (request.method === 'POST' && withdrawalMatch) {
    await jsonBody(request);
    return send(response, await withdrawPhoto(owner, withdrawalMatch[1]!));
  }
  if (request.method === 'POST' && path === '/api/donations') {
    const body = await jsonBody(request);
    requireValue(Object.keys(body).every((key) => ['templeId', 'amount'].includes(key)), 400, 'UNKNOWN_FIELD', 'Only templeId and amount may be specified.');
    return send(response, await createDonation(owner, body.templeId, body.amount), 201);
  }
  const match = path.match(/^\/api\/donations\/(0x[0-9a-f]{64})(?:\/(operation|verify|resolve-approval))?$/i);
  if (match) {
    const id = match[1]!.toLowerCase();
    if (request.method === 'GET' && !match[2]) return send(response, await ownedDonation(id, owner));
    if (request.method === 'POST' && match[2] === 'operation') {
      const body = await jsonBody(request);
      return send(response, await recordOperation(id, owner, body.operation, body.attemptId));
    }
    if (request.method === 'POST' && match[2] === 'resolve-approval') {
      const body = await jsonBody(request);
      requireValue(Object.keys(body).every((key) => ['attemptId', 'confirmNoWalletRequest'].includes(key))
        && typeof body.attemptId === 'string' && body.confirmNoWalletRequest === true,
      400, 'INVALID_BODY', 'An approval attempt ID and explicit no-open-wallet-request confirmation are required.');
      return send(response, await resolveApprovalOnlyIntent(
        id, owner, body.attemptId, body.confirmNoWalletRequest,
      ));
    }
    if (request.method === 'POST' && match[2] === 'verify') {
      const body = await jsonBody(request);
      await ownedDonation(id, owner);
      let pending = inflight.get(id);
      if (!pending) {
        pending = verifyDonation(id, owner, body.txHash).finally(() => inflight.delete(id));
        inflight.set(id, pending);
      }
      return send(response, await pending);
    }
  }
  if (request.method === 'GET' && (path === '/api/collection' || path === '/api/history')) {
    const records = await db.collection('donations').where('ownerWallet', '==', getAddress(owner)).get();
    if (path === '/api/history') {
      const donations = await Promise.all(records.docs.map(async (doc) => {
        const donation = doc.data() as Donation;
        if (donation.status !== 'intent' || donation.donateAttemptId || donation.txHash) return donation;
        const operations = await doc.ref.collection('operations').get();
        if (operations.size !== 1) return donation;
        const operation = operations.docs[0];
        const source = operation.get('source');
        const target = operation.get('target');
        if (operation.get('operation') !== 'approve' || operation.get('chainId') !== CHAIN_ID
          || typeof source !== 'string' || source.toLowerCase() !== owner.toLowerCase()
          || typeof target !== 'string' || target.toLowerCase() !== USDC.toLowerCase()
          || operation.get('amount') !== donation.amount) return donation;
        return { ...donation, approvalAttemptId: operation.id };
      }));
      donations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(response, { donations });
    }
    const donations = records.docs.map((doc) => doc.data() as Donation)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const totals = await db.collection('walletTempleTotals').where('wallet', '==', owner.toLowerCase()).get();
    return send(response, {
      donations, points: Object.fromEntries(totals.docs.map((doc) => [doc.get('templeId'), doc.get('points')])),
      photos: await listOwnedPhotos(owner),
    });
  }
  throw new HttpError(404, 'NOT_FOUND', 'API route not found.');
}
const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const requestId = randomUUID();
    const authFailure = error instanceof Error && 'code' in error
      && typeof error.code === 'string' && error.code.startsWith('auth/');
    const status = error instanceof HttpError ? error.status : authFailure ? 401 : 500;
    const code = error instanceof HttpError ? error.code : authFailure ? 'AUTH_INVALID' : 'INTERNAL_ERROR';
    console.error(JSON.stringify({ event: 'request_failed', requestId, status, code, error: error instanceof Error ? error.name : 'UnknownError' }));
    if (!response.headersSent) send(response, {
      error: code, message: error instanceof HttpError ? error.message : authFailure ? 'Your session expired. Sign in again.' : 'The request failed. Retry verification rather than resending a payment.',
      requestId,
    }, status);
    else response.destroy();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'central_listening', origin, project, chainId: 84532 }));
});
const timer = setInterval(() => { void mintTick(); }, 1000);
const photoTimer = setInterval(() => {
  void cleanupPhotoLifecycle().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'photo_lifecycle_cleanup_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
  });
}, 60000);
const cleanup = setInterval(() => {
  for (const [key, value] of rates) if (Date.now() - value.started > 60000) rates.delete(key);
}, 60000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(photoTimer);
  clearInterval(cleanup);
  server.close();
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
