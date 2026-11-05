import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const policy = spawnSync(process.execPath, ['scripts/check-policy.mjs'], { stdio: 'inherit' });
if (policy.status !== 0) process.exit(policy.status ?? 1);

const output = 'dist/public';
await rm('dist', { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [{ in: 'src/web/main.tsx', out: 'app' }],
  outdir: output,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'es2022',
  jsx: 'automatic',
  legalComments: 'none',
  sourcemap: false,
});
await cp('src/web/index.html', `${output}/index.html`);
await cp('src/web/style.css', `${output}/style.css`);
try {
  await cp('public', output, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
