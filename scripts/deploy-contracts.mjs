import { readFileSync, writeFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient, encodeDeployData, erc20Abi, http,
  keccak256, parseEther, toHex, TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { checkPolicy } from './check-policy.mjs';

checkPolicy();
const privateDirectory = join(process.env.LOCALAPPDATA, 'KALASH', 'secrets');
const wallets = JSON.parse(readFileSync(join(privateDirectory, 'wallets.json'), 'utf8'));
const artifacts = JSON.parse(readFileSync('config/contracts.abi.json', 'utf8'));
const account = privateKeyToAccount(wallets.deployer.privateKey);
const transport = http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org', { timeout: 10000, retryCount: 0 });
const chain = createPublicClient({ chain: baseSepolia, transport });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
const usdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
if (await chain.getChainId() !== 84532
  || !await chain.getCode({ address: usdc })
  || await chain.readContract({ address: usdc, abi: erc20Abi, functionName: 'decimals' }) !== 6) {
  throw new Error('RPC/token configuration mismatch; no transaction sent');
}
const progressPath = join(privateDirectory, 'deployment-progress.json');
const progress = existsSync(progressPath)
  ? JSON.parse(readFileSync(progressPath, 'utf8'))
  : { chainId: 84532, account: account.address, reservedGasWei: '0', contracts: {} };
if (progress.chainId !== 84532 || progress.account !== account.address) throw new Error('Deployment progress mismatch');
function persist() {
  const temporary = `${progressPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
  const descriptor = openSync(temporary, 'r+');
  fsyncSync(descriptor);
  closeSync(descriptor);
  renameSync(temporary, progressPath);
}
async function deploy(name, args) {
  let state = progress.contracts[name];
  if (!state) {
    const artifact = artifacts[name];
    if (!artifact?.bytecode?.startsWith('0x') || !artifact.abi?.length) throw new Error(`Missing compiled ${name}`);
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const gas = await chain.estimateGas({ account, data }) * 12n / 10n;
    const fees = await chain.estimateFeesPerGas();
    const reserve = gas * fees.maxFeePerGas * 2n + 5000000000000n;
    if (BigInt(progress.reservedGasWei) + reserve > parseEther('0.01')) throw new Error('Deployment gas budget reached; no send');
    if (await chain.getBalance({ address: account.address }) < reserve) throw new Error('Deployment gas balance insufficient');
    const nonce = await chain.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const rawTransaction = await account.signTransaction({ type: 'eip1559', chainId: 84532, nonce, data, gas, ...fees });
    state = { rawTransaction, hash: keccak256(rawTransaction), nonce, reservedGasWei: reserve.toString() };
    progress.reservedGasWei = (BigInt(progress.reservedGasWei) + reserve).toString();
    progress.contracts[name] = state;
    persist();
  }
  let receipt;
  try { receipt = await chain.getTransactionReceipt({ hash: state.hash }); } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }
  if (!receipt) {
    try { await wallet.sendRawTransaction({ serializedTransaction: state.rawTransaction }); } catch (error) {
      console.error(JSON.stringify({ operation: name, hash: state.hash, outcome: 'unknown', error: error.name }));
    }
    receipt = await chain.waitForTransactionReceipt({ hash: state.hash, timeout: 90000 });
  }
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed; inspect persisted hash, never reset progress`);
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash || !await chain.getCode({ address: receipt.contractAddress })) throw new Error('Deployment not canonical or no code');
  state.address = receipt.contractAddress;
  state.blockNumber = receipt.blockNumber.toString();
  persist();
  console.log(JSON.stringify({ contract: name, address: state.address, transactionHash: state.hash, blockNumber: state.blockNumber }));
  return state;
}
if (process.argv.includes('--cash-fee-only')) {
  const current = JSON.parse(readFileSync('config/deployment.public.json', 'utf8'));
  if (current.chainId !== 84532 || current.usdc?.toLowerCase() !== usdc.toLowerCase()
    || !current.vault || !current.stamp) throw new Error('Existing public deployment mismatch; no fee deployment sent');
  const cashFeeVault = await deploy('CashFeeVault', [usdc, wallets.minter.address, wallets['fee-recipient'].address]);
  writeFileSync('config/deployment.public.json', `${JSON.stringify({
    ...current, cashFeeVault: cashFeeVault.address, cashFeeVaultTxHash: cashFeeVault.hash,
    cashFeeStartBlock: cashFeeVault.blockNumber,
  }, null, 2)}\n`);
} else {
  const ids = Array.from({ length: 10 }, (_, index) => `temple-${String(index + 1).padStart(2, '0')}`);
  const vault = await deploy('DonationVault', [
    usdc, wallets.minter.address, wallets['fee-recipient'].address,
    ids.map((id) => keccak256(toHex(id))), ids.map((id) => wallets[id].address),
  ]);
  const stamp = await deploy('KalashStamp', [wallets.minter.address]);
  const current = existsSync('config/deployment.public.json') ? JSON.parse(readFileSync('config/deployment.public.json', 'utf8')) : {};
  writeFileSync('config/deployment.public.json', `${JSON.stringify({
    ...current, chainId: 84532, usdc, vault: vault.address, stamp: stamp.address,
    vaultTxHash: vault.hash, stampTxHash: stamp.hash,
    startBlock: vault.blockNumber, compiler: 'solc 0.8.38 / shanghai',
  }, null, 2)}\n`);
}
