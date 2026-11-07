import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
