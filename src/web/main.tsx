import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { createRuntime, type Runtime } from './runtime.ts';
import { App } from './App.tsx';
import { AtmPage } from './Reception.tsx';

const root = createRoot(document.getElementById('root')!);
const queryClient = new QueryClient();

function StartupError({ error }: { error: Error }) {
  return (
    <main className="startup-error">
      <a className="brand" href="/">KALASH<span className="brand-mark">✦</span></a>
      <h1>We could not reach the pilgrim guide</h1>
      <p>{error.message}</p>
      <button className="button button-primary" onClick={() => window.location.reload()}>Try again</button>
    </main>
  );
}

function renderApp(runtime: Runtime) {
  root.render(
    <React.StrictMode>
      <WagmiProvider config={runtime.wagmiConfig} reconnectOnMount>
        <QueryClientProvider client={queryClient}>
          <App runtime={runtime} />
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  );
}

root.render(<div className="startup-loading" role="status">Opening the pilgrim guide…</div>);
const atmId = window.location.pathname.match(/^\/atm\/([a-z0-9-]+)$/)?.[1];
if (atmId) {
  root.render(<React.StrictMode><AtmPage atmId={atmId} /></React.StrictMode>);
} else {
  createRuntime().then(renderApp).catch((error: unknown) => {
    root.render(<StartupError error={error instanceof Error ? error : new Error('An unexpected error occurred.')} />);
  });
}
