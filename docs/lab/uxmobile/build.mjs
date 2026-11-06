import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { checkPolicy } from '../../../scripts/check-policy.mjs';

const lab = dirname(fileURLToPath(import.meta.url));
const repository = resolve(lab, '..', '..', '..');
process.chdir(repository);
checkPolicy();

// Resolve only the locked QR utility; no Reown code is bundled or run.
const appkitRequire = createRequire(import.meta.resolve('@reown/appkit'));
const uiRequire = createRequire(appkitRequire.resolve('@reown/appkit-ui'));
const qrEntry = uiRequire.resolve('qrcode/lib/browser.js');
if (uiRequire('qrcode/package.json').version !== '1.5.3') {
  throw new Error('The lab requires the already-verified qrcode 1.5.3.');
}

const output = join(lab, 'dist');
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'app.mjs', 'probe.mjs', 'style.css']) {
  await cp(join(lab, file), join(output, file));
}
const result = await build({
  stdin: {
    contents: `import QRCode from ${JSON.stringify(qrEntry)};
export async function drawQr(canvas, text) {
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'M', width: 336, margin: 4,
    color: { dark: '#111111', light: '#ffffff' }
  });
}`,
    resolveDir: repository,
    sourcefile: 'uxmobile-qr-entry.mjs',
  },
  outfile: join(output, 'qr.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  metafile: true,
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (input === 'uxmobile-qr-entry.mjs') continue;
  let directory = dirname(resolve(repository, input));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Missing license metadata: ${input}`);
    directory = parent;
  }
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (!['qrcode', 'dijkstrajs', 'encode-utf8'].includes(pkg.name)) {
    throw new Error(`Unexpected dependency in the QR-only bundle: ${pkg.name}`);
  }
  packages.set(pkg.name, { directory, version: pkg.version });
}
const notices = [];
for (const [name, { directory, version }] of packages) {
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'license']
    .map((file) => join(directory, file)).find(existsSync)
    ?? (name === 'encode-utf8' && version === '1.0.3' ? join(lab, 'encode-utf8.LICENSE.txt') : undefined);
  if (!license) throw new Error(`Missing license for ${name}`);
  notices.push(`${name}@${version}\n\n${await readFile(license, 'utf8')}`);
}
await writeFile(join(output, 'third-party-notices.txt'), notices.join('\n\n---\n\n'));
const source = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repository, encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'docs/lab/uxmobile'], {
  cwd: repository, encoding: 'utf8',
}).trim().length > 0;
await writeFile(join(output, 'build-meta.json'), JSON.stringify({
  lab: 'uxmobile', source, dirty, builtAt: new Date().toISOString(),
  packages: Object.fromEntries([...packages].map(([name, value]) => [name, value.version])),
}, null, 2));
console.log(`Built isolated lab ${source}${dirty ? ' (uncommitted lab changes)' : ''}; QR packages: ${[...packages.keys()].join(', ')}`);
