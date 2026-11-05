import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { Donation } from '../shared.ts';
import { db, origin, publicConfig, project } from './config.ts';
import { challenge, identity, verifyChallenge } from './authentication.ts';
import { temples } from './catalog.ts';
import { createDonation, ownedDonation, recordOperation, verifyDonation } from './donations.ts';
import { HttpError, requireValue } from './errors.ts';
import { mintTick } from './mint.ts';

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
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  requireValue(request.headers['content-type']?.split(';')[0] === 'application/json',
    415, 'JSON_REQUIRED', 'Send application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size <= 16384, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
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
    "img-src 'self' data: blob: https://*.walletconnect.com https://*.reown.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com https://sepolia.base.org https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org https://*.reown.com",
    "frame-src 'self' https://*.firebaseapp.com https://verify.walletconnect.com https://verify.walletconnect.org",
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
  ].join('; '));
}
const publicRoot = resolve('dist/public');
async function staticFile(pathname: string, response: ServerResponse) {
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
    requireValue(request.method === 'GET', 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.');
    return staticFile(path, response);
  }
  rateLimit(request, path.startsWith('/api/auth/') ? 'auth' : 'api', path.startsWith('/api/auth/') ? 20 : 120);
  if (request.method === 'POST') {
    requireValue(request.headers.origin === new URL(origin).origin,
      403, 'ORIGIN_MISMATCH', 'Request origin does not match this KALASH deployment.');
  }
  if (request.method === 'GET' && path === '/api/health') return send(response, {
    status: 'ready', project, chainId: 84532, contractsDeployed: Boolean(publicConfig.vault), mintEnabled: process.env.MINT_ENABLED === 'true',
  });
  if (request.method === 'GET' && path === '/api/config') return send(response, publicConfig);
  if (request.method === 'GET' && path === '/api/temples') return send(response, { temples });
  if (request.method === 'POST' && path === '/api/auth/challenge') {
    const body = await jsonBody(request);
    return send(response, await challenge(body.wallet));
  }
  if (request.method === 'POST' && path === '/api/auth/verify') {
    const body = await jsonBody(request);
    return send(response, await verifyChallenge(body.nonce, body.signature));
  }
  const owner = await identity(request.headers.authorization);
  rateLimit(request, owner.toLowerCase(), 100);
  if (request.method === 'POST' && path === '/api/donations') {
    const body = await jsonBody(request);
    requireValue(Object.keys(body).every((key) => ['templeId', 'amount'].includes(key)), 400, 'UNKNOWN_FIELD', 'Only templeId and amount may be specified.');
    return send(response, await createDonation(owner, body.templeId, body.amount), 201);
  }
  const match = path.match(/^\/api\/donations\/(0x[0-9a-f]{64})(?:\/(operation|verify))?$/i);
  if (match) {
    const id = match[1]!.toLowerCase();
    if (request.method === 'GET' && !match[2]) return send(response, await ownedDonation(id, owner));
    if (request.method === 'POST' && match[2] === 'operation') {
      const body = await jsonBody(request);
      return send(response, await recordOperation(id, owner, body.operation, body.attemptId));
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
    const donations = records.docs.map((doc) => doc.data() as Donation)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (path === '/api/history') return send(response, { donations });
    const totals = await db.collection('walletTempleTotals').where('wallet', '==', owner.toLowerCase()).get();
    return send(response, {
      donations, points: Object.fromEntries(totals.docs.map((doc) => [doc.get('templeId'), doc.get('points')])),
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
const cleanup = setInterval(() => {
  for (const [key, value] of rates) if (Date.now() - value.started > 60000) rates.delete(key);
}, 60000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(cleanup);
  server.close();
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
