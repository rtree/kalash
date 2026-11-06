import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createConfig, injected, http } from 'wagmi';
import { connect, disconnect, switchChain } from 'wagmi/actions';
import { type EIP1193RequestFn } from 'viem';
import { BASE_SEPOLIA_RPC, customRpcUrls, kalashChain, switchToKalashChain } from '../src/web/walletNetwork.ts';

test('AppKit Wagmi network metadata preserves the explicit public RPC', () => {
  const adapter = new WagmiAdapter({ projectId: '0'.repeat(32), networks: [kalashChain], customRpcUrls, ssr: true });
  assert.equal(adapter.wagmiConfig.chains[0].rpcUrls.default.http[0], BASE_SEPOLIA_RPC);
  assert.equal(adapter.wagmiConfig.chains[0].rpcUrls.chainDefault?.http[0], BASE_SEPOLIA_RPC);
});
test('the real injected connector adds an unknown chain using only the official RPC', async () => {
  const calls: { method: string; params?: unknown }[] = [];
  let chainId = '0x1';
  let known = false;
  const events = new EventEmitter();
  const request = (async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push({ method, params });
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts': return ['0x0000000000000000000000000000000000000001'];
      case 'eth_chainId': return chainId;
      case 'wallet_switchEthereumChain':
        if (!known) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
        chainId = '0x14a34';
        events.emit('chainChanged', chainId);
        return null;
      case 'wallet_addEthereumChain':
        known = true;
        chainId = '0x14a34';
        events.emit('chainChanged', chainId);
        return null;
      case 'wallet_revokePermissions': return null;
      default: throw new Error(`Unexpected provider method ${method}`);
    }
  }) as EIP1193RequestFn;
  const provider = { request, on: events.on.bind(events), removeListener: events.removeListener.bind(events) };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new EventTarget() as EventTarget & { ethereum?: typeof provider };
  browser.ethereum = provider;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  const config = createConfig({
    chains: [kalashChain], ssr: true, storage: null,
    connectors: [injected({ target: { id: 'metamask', name: 'MetaMask', provider: () => provider } })],
    transports: { [kalashChain.id]: http(BASE_SEPOLIA_RPC) },
  });
  try {
    await connect(config, { connector: config.connectors[0]! });
    await switchChain(config, switchToKalashChain);
    const additions = calls.filter((entry) => entry.method === 'wallet_addEthereumChain');
    assert.equal(additions.length, 1);
    const params = additions[0]!.params as { rpcUrls: string[]; chainId: string }[];
    assert.deepEqual(params[0]!.rpcUrls, [BASE_SEPOLIA_RPC]);
    assert.equal(params[0]!.chainId, '0x14a34');
    await switchChain(config, switchToKalashChain);
    assert.equal(calls.filter((entry) => entry.method === 'wallet_addEthereumChain').length, 1,
      'switching an existing network is not an RPC settings overwrite');
    await disconnect(config);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
