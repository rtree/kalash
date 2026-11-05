import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('policy CLI actually executes and rejects an incorrect Node version on every host', () => {
  const valid = spawnSync(process.execPath, ['scripts/check-policy.mjs'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Policy and release evidence passed/);
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolve } from 'node:path';
    Object.defineProperty(process, 'version', { value: 'v0.0.0' });
    process.argv[1] = resolve('scripts/check-policy.mjs');
    await import('./scripts/check-policy.mjs');
  `], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0, 'A no-op CLI must never pass the dependency gate');
  assert.match(invalid.stderr, /Node version differs/);
});
