import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CASH_ACCEPTANCE_MS, cashAccepting, metaMaskLink, templeTarget, VISIT_REFERENCE, type AtmDto, type VisitDto } from '../atm.ts';
import { DeviceTransitionMs } from '../timing.ts';
import { formatPaise, formatUsdc } from '../shared.ts';
import { payoutApprovalLink } from '../payout.ts';

type Api = <T>(path: string, init?: RequestInit, privateRequest?: boolean) => Promise<T>;
type OwnerVisit = VisitDto & { linkedToYou: boolean; donationId?: string | null };
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
  const [stopVisit, setStopVisit] = useState<string | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [payoutApproval, setPayoutApproval] = useState<{ approvalId: string; url: string } | null>(null);
  const payoutRequestId = useRef<string | null>(null);
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
  const accepting = !error && !busy && stopVisit !== atm?.visit?.id && cashAccepting(atm?.visit, now);
  const cashSeconds = Math.max(0, Math.ceil(((atm?.visit?.cashDeadline ?? 0) - now) / 1000));
  const cashLocked = atm?.visit?.mode === 'cash'
    && ['awaiting_device', 'accepting', 'closing', 'reconciling', 'needs_reconciliation'].includes(atm.visit.state);
  return <div className="app-shell atm-shell">
    <header className="topbar"><span className="brand">KALASH</span><span>Temple ATM</span></header>
    <main className="atm-main">
      <p className="eyebrow">{atm?.name ?? atmId}</p>
      <h1>{atm?.templeName ?? 'Connect this temple screen'}</h1>
      <div className={`notice ${accepting ? 'notice-success' : 'notice-info'}`} role="status">
        {accepting && cashSeconds <= DeviceTransitionMs / 1000
          ? 'Cash reception ends soon. Do not insert another banknote.'
          : accepting ? 'Cash acceptance is active. Insert only one INR note at a time.' : 'Cash is not accepting. Do not insert banknotes.'}
      </div>
      {atm?.cashPolicy === 'interim-ledger' && <p className="notice notice-info">
        Interim CashIN: sign the QR to start reception. Historical ledger differences are retained without blocking the next visit.
      </p>}
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
        : adminMode ? <section className="reception-card">
          <p className="eyebrow">Temple Admin</p>
          <h2>Settle fees and approve full payout</h2>
          <p>{atm.cashPolicy === 'interim-ledger'
            ? 'Verify the registered administrator wallet in Temple Admin. Open Fee Settlement starts full payout after fee submission, or immediately if already paid. Kalash takes settlement risk.'
            : 'This screen cannot authorize dispensing. Only the registered temple administrator can sign the one-use approval on their phone.'}</p>
          <a className={`button ${atm.cashPolicy === 'interim-ledger' ? 'button-primary' : 'button-outline'}`}
            href={`/temple-admin/${encodeURIComponent(atmId)}`} target="_blank" rel="noreferrer">Open Fee Settlement</a>
          {atm.payout ? <p role="status">Payout {atm.payout.payoutId}: {atm.payout.state}, {formatPaise(atm.payout.amountPaise)}.
            {atm.payout.state === 'unknown' ? ' Keep the machine stopped and reconcile; do not resubmit.' : ' Be present to collect banknotes when the device presents them.'}</p> : atm.cashPolicy !== 'interim-ledger' && <>
            <button className="button button-primary" disabled={busy || atm.cashMachineStatus !== 'ready'}
              onClick={() => void act(async () => {
                payoutRequestId.current ??= crypto.randomUUID();
                setPayoutApproval(await screenApi<{ approvalId: string; url: string }>(`${base}/payout-approval`,
                  { requestId: payoutRequestId.current }));
              })}>Pay Out · Show approval QR</button>
            {payoutApproval && <>
              {new URL(payoutApproval.url).protocol === 'https:'
                ? <QrCanvas text={payoutApprovalLink(new URL(payoutApproval.url).origin, atmId, payoutApproval.approvalId)} />
                : <p role="alert">Payout QR requires the deployed HTTPS site.</p>}
              <p className="reception-target">{payoutApproval.url}</p>
              <p>QR is single-use and expires after two minutes. Check temple, ATM and full cash amount on your phone before signing.</p>
            </>}
          </>}
          <button className="button button-outline"
            onClick={() => { setAdminMode(false); setPayoutApproval(null); payoutRequestId.current = null; }}>Back to Donate Screen</button>
        </section> : !atm.visit ? <section className="reception-card">
          <h2>Choose how to give</h2>
          <p>Cash machine: <strong>{atm.cashMachineStatus}</strong>. {atm.cashDisabledReason}</p>
          <div className="atm-methods">
            <button className="button button-primary" disabled={atm.cashPolicy !== 'interim-ledger' && (busy || !atm.cryptoDonationEnabled)} onClick={() => void act(async () => {
              requestId.current ??= crypto.randomUUID();
              setAtm(await screenApi<AtmDto>(`${base}/visits`, { mode: 'crypto', requestId: requestId.current }));
              requestId.current = null;
            })}>Donate with Crypto<br /><small>Continue on your phone</small></button>
            <button className="button button-outline" disabled={atm.cashPolicy !== 'interim-ledger' && (busy || !atm.cashReceptionAvailable)} aria-describedby="cash-unavailable" onClick={() => void act(async () => {
              requestId.current ??= crypto.randomUUID();
              setAtm(await screenApi<AtmDto>(`${base}/visits`, { mode: 'cash', requestId: requestId.current }));
              requestId.current = null;
            })}>
              Cash donation<br/><small id="cash-unavailable">{atm.cashDisabledReason}</small>
            </button>
          </div>
          <p>No cash operation or device command is sent by this screen.</p>
        </section> : <section className="reception-card">
          {waiting ? <>
            <h2>{atm.visit.mode === 'cash' ? 'Authorize this cash reception on your phone' : 'Continue your Crypto donation on your phone'}</h2>
            <p>{atm.visit.mode === 'cash'
              ? `Cash reception for ${atm.templeName}. Signing on the phone binds consent to this ATM session; it does not start acceptance.`
              : `Onsite Crypto reception for ${atm.templeName}. Scan using an external QR reader to open MetaMask.`}</p>
            <p role="timer">QR expires in {seconds} seconds</p>
            {atm.deepLink && <QrCanvas text={atm.deepLink} />}
            {atm.qrUnavailableReason && <p role="alert">{atm.qrUnavailableReason}</p>}
            <p className="reception-target">{atm.targetUrl}</p>
            <p>{atm.visit.mode === 'cash'
              ? 'Reading this QR does not authorize or start the cash machine. Do not insert a note until the ATM explicitly shows Cash acceptance active.'
              : 'Reading this QR does not link a wallet or submit a transaction. Join the onsite donation on your phone.'}</p>
          </> : atm.visit.state === 'linked' ? <>
            <h2>Wallet linked</h2><p>The same onsite Crypto reception is saved on Central. Continue with amount and wallet confirmation on your phone.</p>
            <p>No donation has been submitted yet. Cash remains disabled.</p>
          </> : atm.visit.state === 'awaiting_device' ? <>
            <h2>Waiting for the cash machine</h2>
            <p>The cash-session consent is linked to one wallet. Keep the acceptor disabled until the Controller reports actual Ready.</p>
            <p>Do not insert banknotes.</p>
          </> : atm.visit.state === 'accepting' ? <>
            <h2>{accepting && cashSeconds > DeviceTransitionMs / 1000 ? 'Cash acceptance active' : 'Do not insert banknotes'}</h2>
            <p>Storage recorded: {atm.visit.cashAcceptedPaise === undefined ? 'Awaiting Central' : `${formatPaise(atm.visit.cashAcceptedPaise)} INR`} · limit {formatPaise(atm.visit.cashLimitPaise)} INR.</p>
            <p role="timer">{cashSeconds} seconds remaining. Storage is not a confirmed donation until closing reconciliation.</p>
            <p>{accepting && cashSeconds > DeviceTransitionMs / 1000
              ? 'Insert only one supported INR note at a time. Stop when the timer expires or the screen says closing.'
              : 'Do not insert another banknote. Any note already being processed will be reconciled.'}</p>
            <button className="button button-primary button-wide" disabled={busy} onClick={() => void act(async () => {
              setStopVisit(atm.visit!.id);
              setAtm(await screenApi<AtmDto>(`${base}/visits/${atm.visit!.id}/done`, {}));
            })}>Done · Stop and reconcile</button>
          </> : atm.visit.state === 'closing' || atm.visit.state === 'reconciling' || atm.visit.state === 'needs_reconciliation' ? <>
            <h2>Reconciling cash reception</h2>
            <p>{atm.visit.state === 'needs_reconciliation' ? 'Operator reconciliation is required. This ATM stays locked; no donation or stamp is confirmed from uncertain cash.' : 'Keep this screen open. Do not insert another note or close this reception.'}</p>
          </> : atm.visit.state === 'donation_pending' ? <>
            <h2>{atm.visit.donationState === 'failed' ? 'Donation not confirmed' : 'Confirming donation'}</h2>
            <p>Central will release this ATM only after it verifies the same donation. Do not retry from the ATM.</p>
          </> : atm.visit.state === 'confirmed' ? <>
            <h2>Donation confirmed</h2>
            <p>{atm.visit.mode === 'cash' ? 'Cash storage and closing inventory agree. Your on-site stamp is being issued separately; check Collection on your phone.' : 'Central confirmed the donation.'}</p>
          </> : <><h2>Reception expired or closed</h2><p>No donation was confirmed for this reception. Close it before creating another QR.</p></>}
          <button className="button button-outline button-wide" disabled={busy || cashLocked || (atm.visit.state === 'donation_pending' && atm.visit.donationState !== 'failed')} onClick={() => void act(async () => {
            setAtm(await screenApi<AtmDto>(`${base}/visits/${atm.visit!.id}/close`, {}));
            requestId.current = null;
          })}>{atm.visit.state === 'confirmed' ? 'Finish' : 'Close reception'}</button>
        </section>}
      <a className="text-button" href={atm ? `/board/${atm.templeId}` : '/temples'}>View community board</a>
      {atm && !pairing && !adminMode && <nav aria-label="ATM administration">
        <button className="text-button" onClick={() => setAdminMode(true)}>Temple Admin</button>
      </nav>}
    </main>
  </div>;
}
export function ReceptionPanel({
  reference, templeId, wallet, connected, api, onConnect, onVerify, onCashConsent,
  amountOptions, amount, setAmount, customAmount, setCustomAmount, amountError, amountUnits, feeUnits, netUnits,
  busy, onDonate, onRestoreDonation, onCollection,
}: {
  reference: string; templeId: string; wallet: string | null; connected: boolean; api: Api;
  onConnect: () => void; onVerify: () => void;
  onCashConsent: (message: string) => Promise<string>;
  amountOptions: string[]; amount: string; setAmount: (value: string) => void;
  customAmount: string; setCustomAmount: (value: string) => void; amountError: string;
  amountUnits: bigint; feeUnits: bigint; netUnits: bigint;
  busy: boolean;
  onDonate: (visitId: string, requestId: string) => void; onRestoreDonation: (donationId: string) => Promise<void>;
  onCollection: () => void;
}) {
  const [visit, setVisit] = useState<OwnerVisit | null>(null);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [joining, setJoining] = useState(false);
  const [stopVisit, setStopVisit] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const operation = useRef(false);
  const version = useRef(0);
  const readVersion = useRef(0);
  const restoredDonation = useRef<string | null>(null);
  const donationRequestId = useRef<string | null>(null);
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
        if (active && generation === version.current && currentRead === readVersion.current && !operation.current) {
          setVisit(result);
          setError('');
          if (result.donationId && result.donationId !== restoredDonation.current) {
            restoredDonation.current = result.donationId;
            void onRestoreDonation(result.donationId).catch((cause: unknown) => {
              if (restoredDonation.current === result.donationId) restoredDonation.current = null;
              if (active && generation === version.current) setError(cause instanceof Error ? cause.message : 'Could not restore the confirmed donation.');
            });
          }
        }
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
  }, [api, onRestoreDonation, reference, templeId, wallet, base]);
  const join = async () => {
    if (operation.current) return;
    operation.current = true;
    readVersion.current++;
    const generation = version.current;
    setJoining(true);
    setError('');
    try {
      const result = visit?.mode === 'cash'
        ? await (async () => {
          const challenge = await api<{ nonce: string; message: string }>(`${base}/cash-challenge`, {
            method: 'POST',
            body: JSON.stringify({ templeId }),
          }, true);
          const signature = await onCashConsent(challenge.message);
          return api<OwnerVisit>(`${base}/cash-claim`, {
            method: 'POST',
            body: JSON.stringify({ templeId, nonce: challenge.nonce, signature }),
          }, true);
        })()
        : await api<OwnerVisit>(`${base}/claim`, {
          method: 'POST', body: JSON.stringify({ templeId, consent }),
        }, true);
      if (generation === version.current) setVisit(result);
    } catch (cause) {
      if (generation === version.current) setError(cause instanceof Error ? cause.message : 'Reception was not linked. Restore its state before retrying.');
    } finally { operation.current = false; setJoining(false); }
  };
  const seconds = visit ? Math.max(0, Math.ceil((visit.expiresAt - now) / 1000)) : 0;
  const done = async () => {
    if (operation.current) return;
    operation.current = true;
    readVersion.current++;
    const generation = version.current;
    setJoining(true);
    setStopVisit(reference);
    setError('');
    try {
      const result = await api<OwnerVisit>(`${base}/cash-done`, {
        method: 'POST', body: JSON.stringify({ templeId }),
      }, true);
      if (generation === version.current) setVisit(result);
    } catch (cause) {
      if (generation === version.current) setError(cause instanceof Error ? cause.message : 'The stop request is not confirmed. Do not insert another note; restore this reception.');
    } finally { operation.current = false; setJoining(false); }
  };
  return <section className="reception-card reception-phone">
    <p className="eyebrow">{visit?.mode === 'cash' ? 'ONSITE CASH DONATION' : 'ONSITE CRYPTO DONATION'}</p>
    <h1>{visit?.templeName ?? 'Check the ATM reception'}</h1>
    {error && <div className="notice notice-danger" role="alert">{error}</div>}
    <p>{visit?.mode === 'cash'
      ? 'This QR opens this cash session only. Sign the temple, ATM and session consent on your phone. No banknotes are accepted until the ATM explicitly shows Cash acceptance active.'
      : 'This QR opens the donation page only. Join this reception explicitly, then approve and donate on your phone. The ATM is not taking cash.'}</p>
    {visit && <>
      <p>{visit.atmName} · {visit.mode === 'cash' ? 'Maximum 400 INR per cash session' : 'Base Sepolia · Maximum 1 USDC'}</p>
      {visit.state === 'awaiting_wallet' && seconds > 0 ? <>
        <p role="timer">{visit.mode === 'cash' ? 'Consent QR' : 'Reception'} expires in {seconds} seconds</p>
        {!connected ? <button className="button button-primary" onClick={onConnect}>Connect MetaMask</button>
          : !wallet ? <button className="button button-primary" onClick={onVerify}>Verify wallet</button> : <>
            <label className="reception-consent"><input type="checkbox" checked={consent} disabled={joining || Boolean(error)} onChange={(event) => setConsent(event.target.checked)} />
              {visit.mode === 'cash'
                ? `I authorize this one cash session for ${visit.templeName} at ${visit.atmName}, up to 400 INR.`
                : `I choose to join the Crypto donation for ${visit.templeName} at ${visit.atmName}. No banknotes will be accepted in this flow.`}</label>
            <button className="button button-primary button-wide" disabled={!consent || joining || Boolean(error)} onClick={() => void join()}>
              {joining ? 'Signing reception consent…' : visit.mode === 'cash' ? 'Authorize this cash session' : 'Join onsite Crypto donation'}
            </button>
          </>}
      </> : visit.state === 'awaiting_device' ? <>
        <h2>Waiting for the cash machine</h2>
        <p>Your wallet is linked to this cash session. Wait until the ATM confirms Ready and explicitly starts the {CASH_ACCEPTANCE_MS / 1000}-second acceptance window. Do not insert notes yet.</p>
      </> : visit.state === 'accepting' && visit.mode === 'cash' ? <>
        <h2>{!error && !joining && stopVisit !== reference && cashAccepting(visit, now)
          && (visit.cashDeadline ?? 0) - now > DeviceTransitionMs ? 'Cash acceptance active' : 'Do not insert banknotes'}</h2>
        <p>Storage recorded: {visit.cashAcceptedPaise === undefined ? 'Awaiting Central' : `${formatPaise(visit.cashAcceptedPaise)} INR`} · limit {formatPaise(visit.cashLimitPaise)} INR.</p>
        <p role="timer">{Math.max(0, Math.ceil(((visit.cashDeadline ?? 0) - now) / 1000))} seconds remaining. Only insert a note while the ATM explicitly shows acceptance active. Press Done at the ATM to stop and reconcile.</p>
        {(visit.cashDeadline ?? 0) - now <= DeviceTransitionMs && <p role="alert">Cash reception ends soon. Do not insert another banknote.</p>}
        {visit.linkedToYou && <button className="button button-primary button-wide" disabled={busy || joining} onClick={() => void done()}>Done · Stop and reconcile</button>}
      </> : visit.state === 'closing' || visit.state === 'reconciling' || visit.state === 'needs_reconciliation' ? <>
        <h2>Reconciling cash reception</h2>
        <p>{visit.state === 'needs_reconciliation' ? 'Operator reconciliation is required. Do not insert another note or retry; no donation or stamp is confirmed from uncertain cash.' : 'Central is reconciling physical storage and event records. Do not insert another note or retry.'}</p>
      </> : visit.state === 'linked' && visit.linkedToYou ? <>
        <h2>You're linked to this temple visit</h2>
        <div className="amount-options" role="group" aria-label="Onsite donation amount">
          {amountOptions.map((option) => <button className={amount === option && !customAmount ? 'selected' : ''} key={option} onClick={() => setAmount(option)}>{option}<small>USDC</small></button>)}
        </div>
        <label className="field-label" htmlFor="onsite-custom-amount">Or enter another amount</label>
        <div className={`currency-input ${amountError && customAmount ? 'input-error' : ''}`}>
          <span>$</span><input id="onsite-custom-amount" inputMode="decimal" value={customAmount} onChange={(event) => setCustomAmount(event.target.value)} placeholder="0.01" /><span className="currency-code">USDC</span>
        </div>
        {amountError && customAmount && <p className="inline-error" role="alert">{amountError}</p>}
        <div className="amount-summary">
          <div><span>Your donation</span><strong>{formatUsdc(amountUnits)} USDC</strong></div>
          <div><span>Central fee</span><span>{formatUsdc(feeUnits)} USDC</span></div>
          <div className="summary-total"><span>Temple receives</span><strong>{formatUsdc(netUnits)} USDC</strong></div>
        </div>
        <p>Onsite donations earn On-site Visit stamps after Central confirms the transaction. Your wallet shows the approval and donation requests.</p>
        <button className="button button-primary button-wide" disabled={busy || Boolean(amountError)}
          onClick={() => { donationRequestId.current ??= crypto.randomUUID(); onDonate(reference, donationRequestId.current); }}>
          {busy ? 'Please wait…' : `Donate ${formatUsdc(amountUnits)} USDC`}
        </button>
      </> : visit.state === 'donation_pending' ? visit.donationState === 'failed' ? <>
        <h2>Donation not confirmed</h2>
        <p>Central reports this transaction did not confirm. The ATM will not start another donation from this reception.</p>
      </> : <>
        <h2>Checking the same donation</h2>
        <p>Central has this reception's donation. No second transaction will be started automatically.</p>
        {visit.donationId && <button className="button button-outline" disabled={busy} onClick={() => void onRestoreDonation(visit.donationId!)}>Restore donation status</button>}
      </> : visit.state === 'confirmed' ? <>
        <h2>Donation confirmed</h2>
      </> : visit.state === 'linked' && !wallet ? <>
        <h2>This reception is linked</h2>
        <p>Connect and verify the same wallet that joined this temple visit to continue.</p>
        <button className="button button-outline" onClick={connected ? onVerify : onConnect}>{connected ? 'Verify wallet' : 'Connect MetaMask'}</button>
      </> : visit.state === 'linked' ? <>
        <h2>This reception is already linked</h2>
        <p>It belongs to another wallet. Ask the ATM to close it before starting another.</p>
      </> : <p>This reception expired or closed without a confirmed donation. Return to the ATM before starting another.</p>}
    </>}
    <button className="text-button" onClick={onCollection}>View collection</button>
  </section>;
}
