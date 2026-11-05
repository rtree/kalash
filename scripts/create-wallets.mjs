import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkPolicy } from './check-policy.mjs';

checkPolicy();
const directory = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'KALASH', 'secrets')
  : join(homedir(), '.config', 'kalash', 'secrets');
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (process.platform === 'win32') {
  const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  execFileSync('icacls', [directory, '/inheritance:r', '/grant:r',
    `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe' });
}
const path = join(directory, 'wallets.json');
const roles = ['deployer', 'minter', 'donor',
  ...Array.from({ length: 10 }, (_, index) => `temple-${String(index + 1).padStart(2, '0')}`),
  'fee-recipient'];
let wallets;
if (existsSync(path)) {
  wallets = JSON.parse(readFileSync(path, 'utf8'));
  if (roles.some((role) => !wallets[role]?.privateKey)) throw new Error('Existing wallet file is incomplete; do not overwrite');
} else {
  wallets = Object.fromEntries(roles.map((role) => {
    const privateKey = generatePrivateKey();
    return [role, { privateKey, address: privateKeyToAccount(privateKey).address }];
  }));
  writeFileSync(path, `${JSON.stringify(wallets, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
const publicWallets = Object.fromEntries(roles.map((role) => [role, wallets[role].address]));
mkdirSync('config', { recursive: true });
const budgets = {
  deployer: { eth: '0.01', maxGasEth: '0.01' },
  minter: { eth: '0.003', maxGasEth: '0.003', maxTransactions: 20 },
  donor: { eth: '0.003', usdc: '0.20', maxGasEth: '0.003', maxTransactions: 20, maxPerDonationUsdc: '0.01', maxTotalUsdc: '0.20' },
  'temple-01': { eth: '0.001', usdc: '0.01', maxGasEth: '0.001' },
};
writeFileSync('config/wallets.public.json', `${JSON.stringify({
  chainId: 84532, generatedUtc: new Date().toISOString(), wallets: publicWallets, budgets,
}, null, 2)}\n`);
console.log(JSON.stringify({ chainId: 84532, wallets: publicWallets, funding: budgets, protectedFile: path }, null, 2));
