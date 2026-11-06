import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { checkPolicy, policyFingerprint } from './check-policy.mjs';

checkPolicy({ allowUnverifiedLock: true });
const lock = readFileSync('pnpm-lock.yaml', 'utf8');
const section = lock.split(/\r?\npackages:\r?\n/)[1]?.split(/\r?\nsnapshots:/)[0];
if (!section) throw new Error('Missing lockfile packages section');
if (/^\s+(tarball|repo|commit):/m.test(lock)) throw new Error('Non-registry resolution forbidden');
const entries = [...section.matchAll(/^ {2}(\S[^\r\n]*):\r?$/gm)].map((match) => {
  const key = match[1].replace(/^'|'$/g, '');
  const parsed = key.match(/^(.+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/);
  if (!parsed) throw new Error(`Unsupported registry key: ${key}`);
  return { name: parsed[1], version: parsed[2] };
});
if (entries.length === 0) throw new Error('No locked packages to verify');
const referenceUtc = new Date();
const packages = [];
const cache = new Map();
async function metadata(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Registry ${name}: HTTP ${response.status}`);
      return response.json();
    }).catch((error) => {
      throw new Error(`Registry metadata verification failed for ${name}: ${error.name}`, { cause: error });
    }));
  }
  return cache.get(name);
}
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < entries.length) {
    const entry = entries[next++];
    const meta = await metadata(entry.name);
    const publishedUtc = meta.time?.[entry.version];
    const ageMinutes = (referenceUtc.getTime() - Date.parse(publishedUtc)) / 60000;
    const passed = Number.isFinite(ageMinutes) && ageMinutes >= 10080;
    packages.push({ ...entry, publishedUtc: publishedUtc ?? null, passed });
    if (packages.length % 100 === 0) console.log(`Checked ${packages.length}/${entries.length} locked releases.`);
  }
}));
packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const failed = packages.filter((entry) => !entry.passed);
const report = {
  referenceUtc: referenceUtc.toISOString(),
  registry: 'https://registry.npmjs.org',
  minimumAgeMinutes: 10080,
  lockfileSha256: createHash('sha256').update(lock).digest('hex'),
  policySha256: policyFingerprint(),
  passed: failed.length === 0,
  packages,
};
writeFileSync('dependency-releases.json', `${JSON.stringify(report, null, 2)}\n`);
if (failed.length) throw new Error(`Release age rejected: ${failed.map((e) => `${e.name}@${e.version}`).join(', ')}`);
console.log(`Verified ${packages.length} locked registry releases against ${report.referenceUtc}.`);
