import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

test('policy evidence survives Git LF/Windows CRLF checkout but not a configuration change', () => {
  mkdirSync('artifacts', { recursive: true });
  const fixture = mkdtempSync(join('artifacts', 'policy-eol-'));
  const files = ['package.json', '.npmrc', 'pnpm-workspace.yaml', '.node-version'];
  const script = new URL('../scripts/check-policy.mjs', import.meta.url).href;
  const fingerprint = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { policyFingerprint } from ${JSON.stringify(script)}; console.log(policyFingerprint());`],
    { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    for (const file of files) writeFileSync(join(fixture, file), readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    const lf = fingerprint();
    for (const file of files) writeFileSync(join(fixture, file), readFileSync(join(fixture, file), 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(fingerprint(), lf);
    writeFileSync(join(fixture, '.node-version'), '0.0.0\r\n');
    assert.notEqual(fingerprint(), lf);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
