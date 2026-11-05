import { getAuth, type Auth } from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { baseSepolia } from 'viem/chains';
import { createConfig, http, injected, type Config } from 'wagmi';
import type { PublicConfig, Temple } from '../shared.ts';
import { installWalletLifecycleTrace, recordWalletTrace, sanitizeConnector, startWalletAttempt } from './walletTrace.ts';
import type { AppKit } from '@reown/appkit';

export interface Runtime {
  config: PublicConfig;
  auth: Auth;
  temples: Temple[];
  wagmiConfig: Config;
  openWalletConnect: () => void;
  appKit?: AppKit;
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
  installWalletLifecycleTrace();
  let wagmiConfig: Config;
  let openWalletConnect = () => undefined;
  let appKit: AppKit | undefined;

  if (config.reownProjectId) {
    const adapter = new WagmiAdapter({
      projectId: config.reownProjectId,
      networks: [baseSepolia],
      ssr: false,
    });
    appKit = createAppKit({
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
    const appKitClient = appKit;
    appKitClient.subscribeAccount((account) => {
      recordWalletTrace('appkit-account', {
        connector: appKitClient.getWalletProviderType(),
        chainId: appKitClient.getChainId(),
        connected: account.isConnected,
        addressPresent: Boolean(account.address),
      });
    });
    appKitClient.subscribeNetwork((network) => {
      recordWalletTrace('appkit-network', {
        connector: appKitClient.getWalletProviderType(),
        chainId: network.chainId,
        connected: appKitClient.getIsConnectedState(),
        addressPresent: Boolean(appKitClient.getAddress()),
      });
    });
    appKitClient.subscribeState((state) => {
      if (state.connectingWallet) {
        recordWalletTrace('provider-start', {
          connector: state.connectingWallet.name,
          chainId: appKitClient.getChainId(),
          connected: appKitClient.getIsConnectedState(),
          addressPresent: Boolean(appKitClient.getAddress()),
        });
      }
    });
    appKitClient.subscribeEvents((state) => {
      const current = {
        connector: appKitClient.getWalletProviderType(),
        chainId: appKitClient.getChainId(),
        connected: appKitClient.getIsConnectedState(),
        addressPresent: Boolean(appKitClient.getAddress()),
      };
      switch (state.data.event) {
        case 'SELECT_WALLET':
          recordWalletTrace('provider-start', {
            ...current,
            connector: sanitizeConnector(state.data.properties.name),
          });
          break;
        case 'CONNECT_SUCCESS':
          recordWalletTrace('provider-resolve', current);
          break;
        case 'USER_REJECTED':
        case 'CONNECT_ERROR':
          recordWalletTrace('provider-reject', current);
          break;
      }
    });
    openWalletConnect = () => {
      startWalletAttempt('walletConnect');
      recordWalletTrace('appkit-open-start', { connector: 'walletConnect' });
      void appKitClient.open({ view: 'Connect' }).then(() => {
        recordWalletTrace('appkit-open-resolve', {
          connector: appKitClient.getWalletProviderType(),
          chainId: appKitClient.getChainId(),
          connected: appKitClient.getIsConnectedState(),
          addressPresent: Boolean(appKitClient.getAddress()),
        });
      }).catch(() => {
        recordWalletTrace('appkit-open-reject', {
          connector: appKitClient.getWalletProviderType(),
          chainId: appKitClient.getChainId(),
          connected: appKitClient.getIsConnectedState(),
          addressPresent: Boolean(appKitClient.getAddress()),
        });
      });
    };
  } else {
    wagmiConfig = createConfig({
      chains: [baseSepolia],
      connectors: [injected({ shimDisconnect: true })],
      transports: { [baseSepolia.id]: http() },
    });
  }

  return { config, auth, temples: templeResponse.temples, wagmiConfig, openWalletConnect, appKit };
}
