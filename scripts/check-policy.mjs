import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => { throw new Error(`Dependency policy: ${message}`); };
const read = (file) => readFileSync(file, 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const policyFingerprint = () => hash(
  ['package.json', '.npmrc', 'pnpm-workspace.yaml', '.node-version']
    .map((file) => read(file).replace(/\r\n/g, '\n')).join('\n'),
);

function pnpm(...args) {
  return execFileSync('pnpm', args, { encoding: 'utf8', windowsHide: true }).trim();
}

export function checkPolicy({ allowUnverifiedLock = false } = {}) {
  const pkg = JSON.parse(read('package.json'));
  if (pkg.packageManager !== 'pnpm@10.34.9' || pkg.engines.pnpm !== '10.34.9') fail('packageManager and engines must pin pnpm@10.34.9');
  if (pnpm('--version') !== '10.34.9') fail('actual pnpm version differs');
  if (process.version !== 'v26.13.0' || read('.node-version').trim() !== '26.13.0'
      || pkg.engines.node !== '26.13.0') fail('Node version differs');
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) {
    if (existsSync(file)) fail(`forbidden lockfile ${file}`);
  }
  const expected = {
    'minimum-release-age': 10080,
    'minimum-release-age-exclude': [],
    'ignore-scripts': true,
    'ignore-pnpmfile': true,
    'save-exact': true,
    'enable-pre-post-scripts': false,
  };
  const effective = JSON.parse(pnpm('config', 'list', '--json'));
  for (const [key, value] of Object.entries(expected)) {
    const actual = effective[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) fail(`${key} effective value ${JSON.stringify(actual)}`);
  }
  const workspace = read('pnpm-workspace.yaml');
  if (!/^minimumReleaseAge: 10080$/m.test(workspace)
      || !/^minimumReleaseAgeExclude: \[\]$/m.test(workspace)
      || !/^ignoreScripts: true$/m.test(workspace)
      || !/^ignorePnpmfile: true$/m.test(workspace)) fail('workspace policy differs');
  for (const [section, dependencies] of Object.entries(pkg)) {
    if (!['dependencies', 'devDependencies', 'optionalDependencies'].includes(section)) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) fail(`${name} must use an exact registry version`);
    }
  }
  if (Object.keys(pkg.scripts ?? {}).some((key) => /^(preinstall|install|postinstall|prepare)$/.test(key))) {
    fail('install hooks are forbidden');
  }
  if (existsSync('pnpm-lock.yaml')) {
    if (!allowUnverifiedLock) {
      if (!existsSync('dependency-releases.json')) fail('existing lockfile has no release evidence');
      const report = JSON.parse(read('dependency-releases.json'));
      if (report.lockfileSha256 !== hash(read('pnpm-lock.yaml'))
          || report.policySha256 !== policyFingerprint()
          || report.minimumAgeMinutes !== 10080 || report.passed !== true
          || !Array.isArray(report.packages) || report.packages.length === 0
          || report.packages.some((entry) => entry.passed !== true
            || !Number.isFinite(Date.parse(entry.publishedUtc))
            || (Date.parse(report.referenceUtc) - Date.parse(entry.publishedUtc)) / 60000 < 10080)) {
        fail('stale or invalid release evidence');
      }
    }
    console.log(allowUnverifiedLock ? 'Policy settings passed; lockfile requires release verification.' : 'Policy and release evidence passed.');
  } else {
    console.log('Policy passed: initial acquisition, no lockfile exists yet.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkPolicy();
}
