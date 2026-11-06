import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lab = dirname(fileURLToPath(import.meta.url));
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/probe.mjs', ['probe.mjs', 'text/javascript; charset=utf-8']],
  ['/qr.mjs', ['qr.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/third-party-notices.txt', ['third-party-notices.txt', 'text/plain; charset=utf-8']],
  ['/build-meta.json', ['build-meta.json', 'application/json; charset=utf-8']],
]);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "style-src 'self'",
    "img-src 'self' data:", "media-src 'self' blob:", "connect-src 'none'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=86400',
};

export async function createLabServer({ root = join(lab, 'dist') } = {}) {
  const assets = new Map();
  for (const [path, [file, type]] of routes) {
    assets.set(path, { content: await readFile(join(root, file)), type });
  }
  return createServer((request, response) => {
    const send = (status, type, content, extra = {}) => {
      response.writeHead(status, {
        ...headers, 'Content-Type': type,
        'Content-Length': Buffer.byteLength(content), ...extra,
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    let path;
    try {
      path = new URL(request.url, 'http://localhost').pathname;
    } catch {
      send(400, 'text/plain; charset=utf-8', 'Invalid URL\n');
      return;
    }
    if (path === '/lab-health.json') {
      send(200, 'application/json; charset=utf-8', JSON.stringify({
        ok: true, service: 'kalash-uxmobile', payments: false, uploads: false,
      }));
      return;
    }
    const asset = assets.get(path);
    if (!asset) {
      send(404, 'text/plain; charset=utf-8', 'Not found\n');
      return;
    }
    send(200, asset.type, asset.content);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.version !== 'v26.13.0') throw new Error('Use pinned Node v26.13.0.');
  const port = Number(process.env.PORT ?? 3107);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const server = await createLabServer();
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`KALASH isolated UX lab listening on port ${port}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => server.close());
  }
}
