import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { metaMaskLink, templeTarget, VISIT_REFERENCE, type AtmDto, type VisitDto } from '../atm.ts';

type Api = <T>(path: string, init?: RequestInit, privateRequest?: boolean) => Promise<T>;
type OwnerVisit = VisitDto & { linkedToYou: boolean };
class ReceptionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function screenApi<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new ReceptionError(result.message ?? 'Could not load reception. Restore it rather than starting again.', response.status);
  return result as T;
}
function QrCanvas({ text }: { text: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void QRCode.toCanvas(canvas.current!, text, {
      width: 336, margin: 4, errorCorrectionLevel: 'M',
      color: { dark: '#104d3e', light: '#ffffff' },
    }).catch(() => { if (active) setError('QR generation failed. Use the displayed destination link instead.'); });
    return () => { active = false; };
  }, [text]);
  return <><canvas ref={canvas} hidden={Boolean(error)} className="reception-qr" aria-label="Open this KALASH page in MetaMask" />{error && <p role="alert">{error}</p>}</>;
}
export function PhoneEntry({ origin, templeId, reference }: { origin: string; templeId: string; reference?: string }) {
  if (new URL(origin).protocol !== 'https:') return <p className="muted">Mobile handoff is available on the deployed HTTPS site.</p>;
  const target = templeTarget(origin, templeId, reference);
  const link = metaMaskLink(target, origin);
  return <details className="phone-entry">
    <summary>Open in MetaMask on your phone</summary>
    <p>Use your phone's external QR reader, or open the link on this phone. This only opens the page; it does not connect, sign or pay.</p>
    <div className="phone-entry-qr"><QrCanvas text={link} /></div>
    <a className="button button-outline reception-link" href={link}>Open in MetaMask</a>
    <p className="reception-target">{target}</p>
    <p>MetaMask not installed? Install the official app, then reopen this link. If launch fails, copy the displayed HTTPS address into its browser.</p>
  </details>;
}
export function AtmPage({ atmId }: { atmId: string }) {
  const [atm, setAtm] = useState<AtmDto | null>(null);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const version = useRef(0);
  const working = useRef(false);
  const requestId = useRef<string | null>(null);
  const base = `/api/atm/${encodeURIComponent(atmId)}`;
  const failure = useCallback((cause: unknown) => {
    if (cause instanceof ReceptionError && cause.status === 401) {
      setPairing(true);
      setAtm(null);
    }
    setError(cause instanceof Error ? cause.message : 'Reception could not be restored. Do not insert cash.');
  }, []);
  const refresh = useCallback(async () => {
    if (working.current) return;
    const requestVersion = ++version.current;
    try {
      const state = await screenApi<AtmDto>(base);
      if (requestVersion !== version.current) return;
      setAtm(state);
      setPairing(false);
      setError('');
    } catch (cause) {
      if (requestVersion === version.current) failure(cause);
    }
  }, [base, failure]);
  useEffect(() => {
    if (pairing) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      if (!document.hidden) await refresh();
      inFlight = false;
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    const foreground = () => {
      if (!document.hidden) { clearTimeout(timer); void poll(); }
    };
    void poll();
    document.addEventListener('visibilitychange', foreground);
    return () => { active = false; version.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', foreground); };
  }, [pairing, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const act = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    version.current++;
    setBusy(true);
    setError('');
    try { await action(); } catch (cause) { failure(cause); }
    finally { working.current = false; setBusy(false); }
  };
  const seconds = atm?.visit ? Math.max(0, Math.ceil((atm.visit.expiresAt - now) / 1000)) : 0;
  const waiting = atm?.visit?.state === 'awaiting_wallet' && seconds > 0;
  return <div className="app-shell atm-shell">
    <header className="topbar"><span className="brand">KALASH</span><span>Temple ATM</span></header>
    <main className="atm-main">
      <p className="eyebrow">{atm?.name ?? atmId}</p>
      <h1>{atm?.templeName ?? 'Connect this temple screen'}</h1>
      <div className="notice notice-info" role="status">Reception setup only. Cash acceptance is not enabled. Do not insert banknotes.</div>
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      {pairing ? <form className="reception-card" onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await screenApi(`${base}/pair`, { code: code.trim() });
          setCode('');
          setAtm(await screenApi<AtmDto>(base));
          setPairing(false);
        });
      }}>
        <h2>Authorize the Donate Screen</h2>
        <p>Use the one-time pairing code from this ATM's registered Controller. Opening this URL alone does not grant ATM access.</p>
        <label>Screen pairing code<input autoComplete="off" type="password" value={code} onChange={(event) => setCode(event.target.value)} maxLength={16} required /></label>
        <button className="button button-primary button-wide" disabled={busy}>Pair screen</button>
      </form> : !atm ? <button className="button button-outline" onClick={() => void refresh()}>Restore screen</button>
        : !atm.visit ? <section className="reception-card">
          <h2>Choose how to give</h2>
          <div className="atm-methods">
            <button className="button button-outline" disabled>Crypto donation<br /><small>Available with M5</small></button>
            <button className="button button-primary" disabled={busy} onClick={() => void act(async () => {
              requestId.current ??= crypto.randomUUID();
              setAtm(await screenApi<AtmDto>(`${base}/visits`, { mode: 'cash', requestId: requestId.current }));
              requestId.current = null;
            })}>Cash reception<br /><small>Connect a wallet only</small></button>
          </div>
          <p>Cash maximum: INR 500. Hardware readiness, acceptance and reconciliation must be connected before any banknotes are accepted.</p>
        </section> : <section className="reception-card">
          {waiting ? <>
            <h2>Connect on your phone</h2>
            <p>Cash reception for {atm.templeName}. Scan using an external QR reader to open MetaMask.</p>
            <p role="timer">QR expires in {seconds} seconds</p>
            {atm.deepLink && <QrCanvas text={atm.deepLink} />}
            {atm.qrUnavailableReason && <p role="alert">{atm.qrUnavailableReason}</p>}
            <p className="reception-target">{atm.targetUrl}</p>
            <p>Reading this QR does not link a wallet or start the cash machine. Confirm the reception on your phone.</p>
          </> : atm.visit.state === 'linked' ? <>
            <h2>Wallet linked</h2><p>The same reception is saved on Central. No donation has been made.</p>
            <p>Hardware setup is required before accepting cash. Do not insert banknotes.</p>
          </> : <><h2>Reception expired or closed</h2><p>No cash acceptance was started. Close this reception before creating another QR.</p></>}
          <button className="button button-outline button-wide" disabled={busy} onClick={() => void act(async () => {
            setAtm(await screenApi<AtmDto>(`${base}/visits/${atm.visit!.id}/close`, {}));
            requestId.current = null;
          })}>Close reception (no cash started)</button>
        </section>}
      <a className="text-button" href={atm ? `/board/${atm.templeId}` : '/temples'}>View community board</a>
    </main>
  </div>;
}
export function ReceptionPanel({ reference, templeId, wallet, api, onConnect, onVerify, signMessage, onCollection }: {
  reference: string; templeId: string; wallet: string | null; api: Api;
  onConnect: () => void; onVerify: () => void; signMessage: (message: string) => Promise<string>; onCollection: () => void;
}) {
  const [visit, setVisit] = useState<OwnerVisit | null>(null);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const operation = useRef(false);
  const version = useRef(0);
  const readVersion = useRef(0);
  const base = `/api/visits/${reference}`;
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const generation = ++version.current;
    setVisit(null);
    setConsent(false);
    const load = async () => {
      if (inFlight || operation.current || document.hidden) return;
      if (!VISIT_REFERENCE.test(reference)) { setError('Invalid reception reference. Scan a new QR at the ATM.'); return; }
      inFlight = true;
      const currentRead = ++readVersion.current;
      try {
        const result = await api<OwnerVisit>(`${base}${wallet ? '/mine' : ''}?templeId=${encodeURIComponent(templeId)}`, {}, Boolean(wallet));
        if (active && generation === version.current && currentRead === readVersion.current && !operation.current) { setVisit(result); setError(''); }
      } catch (cause) {
        if (active && generation === version.current && currentRead === readVersion.current) setError(cause instanceof Error ? cause.message : 'Could not restore this reception.');
      } finally { inFlight = false; }
    };
    void load();
    const poll = setInterval(() => void load(), 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const foreground = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', foreground);
    return () => { active = false; version.current++; clearInterval(poll); clearInterval(clock); document.removeEventListener('visibilitychange', foreground); };
  }, [api, reference, templeId, wallet, base]);
  const join = async () => {
    if (operation.current) return;
    operation.current = true;
    readVersion.current++;
    const generation = version.current;
    setBusy(true);
    setError('');
    try {
      const challenge = await api<{ nonce: string; message: string }>(`${base}/challenge`, {
        method: 'POST', body: JSON.stringify({ templeId }),
      }, true);
      const signature = await signMessage(challenge.message);
      if (generation !== version.current) throw new Error('Wallet or reception changed. No claim was submitted.');
      const result = await api<OwnerVisit>(`${base}/claim`, {
        method: 'POST', body: JSON.stringify({ templeId, nonce: challenge.nonce, signature, consent }),
      }, true);
      if (generation === version.current) setVisit(result);
    } catch (cause) {
      if (generation === version.current) setError(cause instanceof Error ? cause.message : 'Reception was not linked. Restore its state before retrying.');
    } finally { operation.current = false; setBusy(false); }
  };
  const seconds = visit ? Math.max(0, Math.ceil((visit.expiresAt - now) / 1000)) : 0;
  return <section className="reception-card reception-phone">
    <p className="eyebrow">ONSITE CASH RECEPTION</p>
    <h1>{visit?.templeName ?? 'Check the ATM reception'}</h1>
    {error && <div className="notice notice-danger" role="alert">{error}</div>}
    <p>Cash acceptance is not enabled yet. Do not insert banknotes. This step only links your wallet; it does not send tokens or create a donation.</p>
    {visit && <>
      <p>{visit.atmName} · Maximum INR 500</p>
      {visit.state === 'awaiting_wallet' && seconds > 0 ? <>
        <p role="timer">Reception expires in {seconds} seconds</p>
        {!wallet ? <div className="reception-actions">
          <button className="button button-outline" onClick={onConnect}>Connect MetaMask</button>
          <button className="button button-primary" onClick={onVerify}>Verify wallet</button>
        </div> : <>
          <label className="reception-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />I confirm this temple, ATM and cash reception. I will not insert cash until the machine is ready.</label>
          <button className="button button-primary button-wide" disabled={!consent || busy || Boolean(error)} onClick={() => void join()}>{busy ? 'Confirm in MetaMask...' : 'Sign and link this cash reception'}</button>
        </>}
      </> : visit.state === 'linked' ? <h2>{visit.linkedToYou ? 'Your wallet is linked' : 'This reception is already linked'}</h2>
        : <p>This reception is expired or closed. Ask the ATM for a new QR; no cash has been accepted.</p>}
    </>}
    <button className="text-button" onClick={onCollection}>View collection</button>
  </section>;
}
