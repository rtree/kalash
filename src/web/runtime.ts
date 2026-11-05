import { getAuth, type Auth } from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { baseSepolia } from 'viem/chains';
import { createConfig, http, injected, type Config } from 'wagmi';
import type { PublicConfig, Temple } from '../shared.ts';

export interface Runtime {
  config: PublicConfig;
  auth: Auth;
  temples: Temple[];
  wagmiConfig: Config;
  openWalletConnect: () => void;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function createRuntime(): Promise<Runtime> {
  const [config, templeResponse] = await Promise.all([
    getJson<PublicConfig>('/api/config'),
    getJson<{ temples: Temple[] }>('/api/temples'),
  ]);
  if (config.chainId !== baseSepolia.id) {
    throw new Error('KALASH is configured for Base Sepolia only. Please try again later.');
  }
  if (!config.firebase?.apiKey || !config.firebase.authDomain || !config.firebase.projectId || !config.firebase.appId) {
    throw new Error('Firebase sign-in is not configured. Donations are unavailable.');
  }

  const auth = getAuth(initializeApp(config.firebase));
  let wagmiConfig: Config;
  let openWalletConnect = () => undefined;

  if (config.reownProjectId) {
    const adapter = new WagmiAdapter({
      projectId: config.reownProjectId,
      networks: [baseSepolia],
      ssr: false,
    });
    const appKit = createAppKit({
      adapters: [adapter],
      networks: [baseSepolia],
      projectId: config.reownProjectId,
      enableCoinbase: false,
      enableBaseAccount: false,
      enableInjected: true,
      defaultAccountTypes: { eip155: 'eoa' },
      features: {
        analytics: false,
        email: false,
        socials: false,
        reownAuthentication: false,
        onramp: false,
        swaps: false,
        history: true,
      },
      metadata: {
        name: 'KALASH',
        description: 'A pilgrim’s guide to giving and collecting real temple stamps.',
        url: window.location.origin,
        icons: [],
      },
    });
    wagmiConfig = adapter.wagmiConfig;
    openWalletConnect = () => {
      void appKit.open({ view: 'Connect' });
    };
  } else {
    wagmiConfig = createConfig({
      chains: [baseSepolia],
      connectors: [injected({ shimDisconnect: true })],
      transports: { [baseSepolia.id]: http() },
    });
  }

  return { config, auth, temples: templeResponse.temples, wagmiConfig, openWalletConnect };
}
