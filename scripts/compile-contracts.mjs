import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

export async function compileContracts({ writeArtifacts = true } = {}) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'check-policy.mjs')], {
    cwd: root, stdio: 'inherit',
  });
  const { default: solc } = await import('solc');
  if (!solc.version().startsWith('0.8.38+')) throw new Error('Expected solc 0.8.38');
  const sources = {};
  for (const name of ['DonationVault.sol', 'KalashStamp.sol', 'CashFeeVault.sol', 'test/MockUSDC.sol']) {
    sources[`contracts/${name}`] = {
      content: await readFile(path.join(root, 'contracts', ...name.split('/')), 'utf8'),
    };
  }
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }), {
    import(name) {
      try {
        return { contents: readFileSync(require.resolve(name), 'utf8') };
      } catch {
        return { error: `Cannot resolve Solidity import: ${name}` };
      }
    },
  }));
  const errors = (result.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const artifacts = {};
  for (const [source, name] of [
    ['contracts/DonationVault.sol', 'DonationVault'],
    ['contracts/KalashStamp.sol', 'KalashStamp'],
    ['contracts/CashFeeVault.sol', 'CashFeeVault'],
    ['contracts/test/MockUSDC.sol', 'MockUSDC'],
  ]) {
    const compiled = result.contracts[source][name];
    artifacts[name] = { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
  }
  if (writeArtifacts) {
    await mkdir(path.join(root, 'config'), { recursive: true });
    const { DonationVault, KalashStamp, CashFeeVault } = artifacts;
    await writeFile(path.join(root, 'config', 'contracts.abi.json'),
      `${JSON.stringify({ DonationVault, KalashStamp, CashFeeVault }, null, 2)}\n`);
  }
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const artifacts = await compileContracts();
  console.log(`Compiled ${Object.keys(artifacts).join(', ')} with solc 0.8.38 (Shanghai).`);
}
