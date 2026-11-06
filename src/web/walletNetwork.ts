import { baseSepolia } from 'viem/chains';

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
} as const;
