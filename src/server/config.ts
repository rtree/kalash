import { readFileSync, existsSync } from 'node:fs';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { CHAIN_ID, USDC, type PublicConfig } from '../shared.ts';
import { cashFeeAbi } from '../payout.ts';

export const project = process.env.GOOGLE_CLOUD_PROJECT ?? 'kalash-donation';
export const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
const serviceAccount = `kalash-central@${project}.iam.gserviceaccount.com`;
initializeApp({ credential: applicationDefault(), projectId: project, serviceAccountId: serviceAccount });
export const auth = getAuth();
export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
const secretManager = new SecretManagerServiceClient();
async function secret(name: string): Promise<string> {
  const [version] = await secretManager.accessSecretVersion({
    name: `projects/${project}/secrets/${name}/versions/latest`,
  });
  const value = version.payload?.data?.toString().trim();
  if (!value) throw new Error(`Empty secret ${name}`);
  return value;
}
const key = await secret('kalash-minter-key');
if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('Invalid minter secret format');
export const minter = privateKeyToAccount(key as Hex);
const expectedMinter = JSON.parse(readFileSync('config/wallets.public.json', 'utf8')).wallets.minter;
if (minter.address.toLowerCase() !== expectedMinter.toLowerCase()) throw new Error('Minter secret does not match registered public address');
const rpc = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
export const chain = createPublicClient({ chain: baseSepolia, transport: http(rpc, { timeout: 10000, retryCount: 1 }) });
export const signer = createWalletClient({ account: minter, chain: baseSepolia, transport: http(rpc, { timeout: 10000, retryCount: 0 }) });
if (await chain.getChainId() !== CHAIN_ID) throw new Error('RPC chain must be Base Sepolia');
if (!await chain.getCode({ address: USDC })) throw new Error('USDC contract missing');
if (await chain.readContract({ address: USDC, abi: erc20Abi, functionName: 'decimals' }) !== 6) throw new Error('USDC decimals mismatch');
interface Deployment { chainId: number; vault: Address; stamp: Address; startBlock: string; cashFeeVault?: Address }
export const deployment: Deployment | null = existsSync('config/deployment.public.json')
  ? JSON.parse(readFileSync('config/deployment.public.json', 'utf8')) : null;
if (deployment) {
  if (deployment.chainId !== CHAIN_ID) throw new Error('Deployment chain mismatch');
  deployment.vault = getAddress(deployment.vault);
  deployment.stamp = getAddress(deployment.stamp);
  for (const address of [deployment.vault, deployment.stamp]) {
    if (!await chain.getCode({ address })) throw new Error('Configured contract has no code');
  }
  if (deployment.cashFeeVault) {
    deployment.cashFeeVault = getAddress(deployment.cashFeeVault);
    const [code, token, authorizer, recipient] = await Promise.all([
      chain.getCode({ address: deployment.cashFeeVault }),
      chain.readContract({ address: deployment.cashFeeVault, abi: cashFeeAbi, functionName: 'token' }),
      chain.readContract({ address: deployment.cashFeeVault, abi: cashFeeAbi, functionName: 'authorizer' }),
      chain.readContract({ address: deployment.cashFeeVault, abi: cashFeeAbi, functionName: 'feeRecipient' }),
    ]);
    const expectedRecipient = JSON.parse(readFileSync('config/wallets.public.json', 'utf8')).wallets['fee-recipient'];
    if (!code || getAddress(token) !== USDC || getAddress(authorizer) !== minter.address
      || getAddress(recipient) !== getAddress(expectedRecipient)) throw new Error('CashFeeVault configuration mismatch');
  }
}
const firebase = JSON.parse(readFileSync('config/firebase.public.json', 'utf8')) as PublicConfig['firebase'];
export const publicConfig: PublicConfig = {
  chainId: CHAIN_ID, usdc: USDC, vault: deployment?.vault ?? null, stamp: deployment?.stamp ?? null,
  cashFeeVault: deployment?.cashFeeVault ?? null,
  reownProjectId: await secret('kalash-reown-project-id'), firebase, origin,
};
