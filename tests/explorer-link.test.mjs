import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';

const output = buildSync({
  entryPoints: ['src/web/ExplorerLink.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external',
}).outputFiles[0].text;
const module = { exports: {} };
runInNewContext(output, { module, exports: module.exports, require: createRequire(import.meta.url) });
const { ExplorerLink } = module.exports;

test('wallet and transaction text show only 0x plus four digits and ellipsis with exact new-tab Explorer links', () => {
  for (const [kind, value] of [
    ['address', `0x1234${'a'.repeat(36)}`],
    ['tx', `0x5678${'b'.repeat(60)}`],
  ]) {
    const html = renderToStaticMarkup(createElement(ExplorerLink, { value, kind }));
    assert.ok(html.includes(`href="https://sepolia.basescan.org/${kind}/${value}"`));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.endsWith(`>${value.slice(0, 6)}...</a>`));
    assert.equal(html.split('>')[1].split('<')[0].includes(value), false);
    assert.equal(html.includes('title='), false);
  }
});

test('ATM keeps administrator controls only in admin view and its entry below the community board', () => {
  const bundled = buildSync({
    entryPoints: ['src/web/Reception.tsx'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external',
  }).outputFiles[0].text;
  for (const adminMode of [false, true]) {
    let slot = 0;
    const atm = { cashPolicy: 'interim-ledger', cashMachineStatus: 'unavailable',
      cashReceptionAvailable: false, cryptoDonationEnabled: false, visit: null,
      payout: { payoutId: 'existing-payout', state: 'unknown', amountPaise: '90000' } };
    const loaded = { exports: {} };
    const require = createRequire(import.meta.url);
    runInNewContext(bundled, { module: loaded, exports: loaded.exports, URL, require: (name) => name === 'react'
      ? { ...React, useState: (initial) => [slot++ === 0 ? atm : slot === 7 ? adminMode : initial, () => {}],
        useRef: (initial) => ({ current: initial }), useEffect: () => {}, useCallback: (fn) => fn }
      : require(name) });
    const html = renderToStaticMarkup(loaded.exports.AtmPage({ atmId: 'atm-01' }));
    if (!adminMode) {
      assert.equal(html.includes('Open Fee Settlement'), false);
      assert.equal(html.includes('Back to Donate Screen'), false);
      assert.ok(html.includes('Donate with Crypto'));
      assert.ok(html.includes('Cash donation'));
      assert.equal(/<button[^>]*disabled/.test(html), false);
      assert.ok(html.indexOf('View community board') < html.indexOf('>Temple Admin</button>'));
      assert.ok(html.includes('aria-label="ATM administration"'));
    } else {
      assert.equal(html.match(/Open Fee Settlement<\/a>/g)?.length, 1);
      assert.equal(html.match(/Back to Donate Screen<\/button>/g)?.length, 1);
      assert.equal(/<button[^>]*disabled[^>]*>Back to Donate Screen/.test(html), false);
      assert.equal(html.includes('aria-label="ATM administration"'), false);
    }
  }
});
