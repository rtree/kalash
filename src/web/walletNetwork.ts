import { baseSepolia } from 'viem/chains';
import { BaseError, getAddress, type Address, type WalletClient } from 'viem';

export async function authorizeSigningAccount(
  client: Pick<WalletClient, 'requestAddresses' | 'request'>, expected: Address, renewPermission = false,
): Promise<void> {
  if (renewPermission)
    await client.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  let accounts: Address[];
  try { accounts = await client.requestAddresses(); }
  catch (error) {
    const unauthorized = error instanceof BaseError && error.walk((cause) =>
      typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 4100);
    if (!unauthorized || !('code' in unauthorized) || unauthorized.code !== 4100) throw error;
    await client.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    accounts = await client.requestAddresses();
  }
  if (!accounts.some((account) => getAddress(account) === getAddress(expected))) {
    await client.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    accounts = await client.requestAddresses();
  }
  if (!accounts.some((account) => getAddress(account) === getAddress(expected))) {
    throw new Error('Authorize the connected wallet account in MetaMask, or reconnect KALASH to the account you selected.');
  }
}

export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
export const kalashChain = {
  ...baseSepolia,
  rpcUrls: {
    default: { http: [BASE_SEPOLIA_RPC] },
    chainDefault: { http: [BASE_SEPOLIA_RPC] },
  },
} as const;
export const customRpcUrls = {
  'eip155:84532': [{ url: BASE_SEPOLIA_RPC }],
};
export const switchToKalashChain = {
  chainId: kalashChain.id,
  addEthereumChainParameter: {
    chainName: kalashChain.name,
    nativeCurrency: kalashChain.nativeCurrency,
    rpcUrls: [BASE_SEPOLIA_RPC],
    blockExplorerUrls: [kalashChain.blockExplorers.default.url],
  },
};
