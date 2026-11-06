import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createLabServer } from './server.mjs';

test('missing build assets fail startup instead of serving a false-ready health check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kalash-uxmobile-missing-'));
  try {
    await assert.rejects(createLabServer({ root }), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isolated HTTP service serves only explicit public assets, without APIs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kalash-uxmobile-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['index.html', 'app.mjs', 'probe.mjs', 'qr.mjs', 'style.css',
    'third-party-notices.txt', 'build-meta.json']) {
    await writeFile(join(root, file), file);
  }
  const server = await createLabServer({ root });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  await t.test('HTML and modules work with strict camera-only headers', async () => {
    const response = await fetch(`${origin}/?mode=phone&case=external-qr`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'index.html');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()');
    const module = await fetch(`${origin}/qr.mjs`);
    assert.equal(module.status, 200);
    assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });
  await t.test('health is static and truthful; HEAD has no body', async () => {
    const response = await fetch(`${origin}/lab-health.json`);
    assert.deepEqual(await response.json(), {
      ok: true, service: 'kalash-uxmobile', payments: false, uploads: false,
    });
    const head = await fetch(origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('index.html')));
  });
  await t.test('APIs, sources, private configuration and traversal are not served', async () => {
    for (const path of ['/api/temples', '/api/donations', '/server.mjs', '/research.md',
      '/.env', '/config/wallets.public.json', '/%2e%2e/server.mjs', '/%2findex.html']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }
  });
  await t.test('mutation methods are rejected', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(origin, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  });
});
