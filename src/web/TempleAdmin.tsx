import { useEffect, useRef, useState } from 'react';
import { erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { CHAIN_ID, formatPaise, formatUsdc, type PublicConfig } from '../shared.ts';
import { cashFeeAbi, payoutTotal, type CashFeeInvoice, type PayoutInventoryReport, type PayoutState } from '../payout.ts';
import { switchToKalashChain } from './walletNetwork.ts';

type Api = <T>(url: string, init?: RequestInit, privateRequest?: boolean) => Promise<T>;
interface AdminState {
  atmId: string; templeId: string; cashEnabled: boolean; activeReception: boolean;
  reconciliationRequired: boolean; controllerReady: boolean; cashFeeVaultAvailable: boolean;
  inventory: PayoutInventoryReport | null; invoice: CashFeeInvoice | null;
  payout: { command: { payoutId: string; amountPaise: string }; state: PayoutState; reconciled?: boolean; endState?: unknown } | null;
}
interface ApprovalContext {
  approvalId: string; atmId: string; templeId: string; amountPaise: string; expiresAt: number; message: string;
}
export function TempleAdmin({ atmId, approvalId, wallet, config, api, onSign }: {
  atmId: string; approvalId: string | null; wallet: string | null; config: PublicConfig; api: Api;
  onSign: (message: string) => Promise<Hex>;
}) {
  const [state, setState] = useState<AdminState | null>(null);
  const [approval, setApproval] = useState<ApprovalContext | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [approved, setApproved] = useState(false);
  const working = useRef(false);
  const requestId = useRef<string | null>(null);
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const base = `/api/temple-admin/${encodeURIComponent(atmId)}`;
  const refresh = async () => setState(await api<AdminState>(base, {}, true));
  useEffect(() => {
    setState(null); setApproval(null); setError(''); setApproved(false);
    if (!wallet) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<AdminState>(base, {}, true);
        if (active) setState(result);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Could not restore payout state.'); }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [api, base, wallet]);
  useEffect(() => {
    if (!approvalId || approved) return;
    let active = true;
    void api<ApprovalContext>(`/api/payout-approvals/${encodeURIComponent(approvalId)}`)
      .then((result) => {
        if (result.atmId !== atmId) throw new Error('Payout QR belongs to another ATM.');
        if (active) setApproval(result);
      }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Payout QR could not be verified.'); });
    return () => { active = false; };
  }, [api, approvalId, atmId, approved]);
  const act = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation unresolved. Restore the same invoice or payout; do not retry payment or dispensing.'); }
    finally { working.current = false; setBusy(false); }
  };
  const pay = async (invoice: CashFeeInvoice) => {
    if (!address || !wallet || getAddress(address) !== getAddress(wallet)
      || getAddress(invoice.payer) !== getAddress(address)) throw new Error('Verify the registered fee-payment wallet first.');
    if (!client) throw new Error('Base Sepolia client is unavailable.');
    if (chainId !== CHAIN_ID) await switchChainAsync(switchToKalashChain);
    const amount = BigInt(invoice.amount);
    const allowance = await client.readContract({ address: config.usdc, abi: erc20Abi,
      functionName: 'allowance', args: [address, invoice.vault] });
    const storageKey = `kalash:fee-approval:${invoice.invoiceId}`;
    const pendingApproval = localStorage.getItem(storageKey);
    if (allowance < amount) {
      if (pendingApproval) {
        if (!/^0x[0-9a-f]{64}$/i.test(pendingApproval)) throw new Error('USDC approval outcome is unknown. Inspect the existing wallet operation, do not resubmit.');
        const receipt = await client.getTransactionReceipt({ hash: pendingApproval as Hex });
        if (receipt.status !== 'success') throw new Error('Existing USDC approval failed. No fee was submitted.');
        throw new Error('Existing approval has insufficient allowance. Inspect the wallet operation before proceeding.');
      }
      localStorage.setItem(storageKey, 'unknown');
      const hash = await writeContractAsync({ address: config.usdc, abi: erc20Abi, functionName: 'approve',
        args: [invoice.vault, amount], chainId: CHAIN_ID, account: address });
      localStorage.setItem(storageKey, hash);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error('USDC approval failed. No fee was submitted.');
      const updated = await client.readContract({ address: config.usdc, abi: erc20Abi,
        functionName: 'allowance', args: [address, invoice.vault] });
      if (updated < amount) throw new Error('Exact fee allowance was not established.');
    }
    await api(`${base}/invoices/${invoice.invoiceId}/operation`, { method: 'POST', body: '{}' }, true);
    const hash = await writeContractAsync({ address: invoice.vault, abi: cashFeeAbi, functionName: 'payFee',
      args: [invoice.invoiceId, invoice.templeKey, amount, BigInt(invoice.deadline), invoice.signature],
      chainId: CHAIN_ID, account: address });
    localStorage.setItem(`kalash:fee-payment:${invoice.invoiceId}`, hash);
    await api(`${base}/invoices/${invoice.invoiceId}/verify`, { method: 'POST', body: JSON.stringify({ txHash: hash }) }, true);
    setNotice('Existing payment submitted for canonical receipt verification. Do not pay it again.');
  };
  const invoice = state?.invoice;
  const payoutActive = state?.payout && !state.payout.reconciled && !['reported', 'precondition_failed'].includes(state.payout.state);
  return <section className="reception-card">
    <p className="eyebrow">Temple Admin · Base Sepolia</p>
    <h1>Cash settlement and full payout</h1>
    <p>ATM {atmId}. Connect and verify the explicitly registered temple administrator wallet using the header controls.</p>
    {error && <div className="notice notice-danger" role="alert">{error}</div>}
    {notice && <div className="notice notice-info" role="status">{notice}</div>}
    {!wallet ? <p>Administrator authentication is required. Opening this page or a QR does not authorize dispensing.</p> : state && <>
      <p>Cash setting: {state.cashEnabled ? 'ON (gated)' : 'OFF'}. Controller: {state.controllerReady ? 'ready' : 'unavailable'}.</p>
      {state.inventory && <p>Payout compartment: <strong>{formatPaise(payoutTotal(state.inventory.inventory))}</strong>.
        Cashbox is excluded. Observation: {new Date(state.inventory.observedAt).toLocaleTimeString()}.</p>}
      {state.activeReception && <p role="alert">Finish the current donation before settlement or payout.</p>}
      {state.reconciliationRequired && <p role="alert">Operator reconciliation required. No automatic retry or new cash intake.</p>}
      {!state.cashFeeVaultAvailable && <p role="alert">CashFeeVault is not deployed. Fee payment and payout remain unavailable.</p>}
      {invoice && <div>
        <h2>Exact cash fee invoice</h2>
        <p>Cash covered: {formatPaise(invoice.cashPaise)}. Fee: <strong>{formatUsdc(invoice.amount)} USDC (3%)</strong>.</p>
        <p>Fee payer: {invoice.payer}. Destination: {invoice.recipient}.</p>
        <p>Status: {invoice.status}. Donation recipient and existing history are unchanged.</p>
        {invoice.status === 'awaiting_payment'
          ? <button className="button button-primary" disabled={busy} onClick={() => void act(() => pay(invoice))}>Pay this exact fee once</button>
          : invoice.status !== 'paid' && <button className="button button-outline" disabled={busy} onClick={() => void act(async () => {
            const txHash = localStorage.getItem(`kalash:fee-payment:${invoice.invoiceId}`);
            await api(`${base}/invoices/${invoice.invoiceId}/verify`, {
              method: 'POST', body: JSON.stringify(txHash ? { txHash } : {}),
            }, true);
          })}>Verify existing payment · no resubmission</button>}
      </div>}
      <button className="button button-outline" disabled={busy || !state.cashFeeVaultAvailable || state.activeReception
        || state.reconciliationRequired || Boolean(payoutActive) || Boolean(invoice && invoice.status !== 'paid')}
        onClick={() => void act(async () => {
          requestId.current ??= crypto.randomUUID();
          await api(`${base}/invoice`, { method: 'POST', body: JSON.stringify({ requestId: requestId.current }) }, true);
          requestId.current = null;
        })}>Create invoice for new unsettled cash</button>
      {state.payout && <p role="status">Payout {state.payout.command.payoutId}: {state.payout.state}.
        {state.payout.state === 'unknown' && ' Keep the machine stopped and reconcile; never send the dispense command again.'}</p>}
      {state.payout?.state === 'unknown' && state.payout.endState && !state.payout.reconciled
        ? <button className="button button-outline" disabled={busy} onClick={() => void act(async () => {
          const result = await api<{ message: string }>(`${base}/reconciliation`, {
            method: 'POST', body: JSON.stringify({ payoutId: state.payout!.command.payoutId }),
          }, true);
          const signature = await onSign(result.message);
          await api(`${base}/reconciliation`, { method: 'POST',
            body: JSON.stringify({ payoutId: state.payout!.command.payoutId, signature }) }, true);
          setNotice('Reconciliation approved only. The Controller must still verify unchanged physical inventory before the lock is retired.');
        })}>Review and sign partial-end reconciliation · no dispensing</button> : null}
      {approval && !approved && <div>
        <h2>Confirm one full payout</h2>
        <p>{approval.templeId} / {approval.atmId}: {formatPaise(approval.amountPaise)}. Be present to collect notes from the bezel.</p>
        <pre className="reception-target">{approval.message}</pre>
        <button className="button button-primary" disabled={busy || Date.now() >= approval.expiresAt}
          onClick={() => void act(async () => {
            const signature = await onSign(approval.message);
            await api(`${base}/approvals/${approval.approvalId}/approve`, { method: 'POST', body: JSON.stringify({ signature }) }, true);
            setApproved(true); setApproval(null); setNotice('One payout authorized. Observe the actual machine result; do not resubmit.');
          })}>Sign and approve this full payout once</button>
      </div>}
      {!approvalId && <p>After fee confirmation, use Temple Admin on the paired ATM to display the one-use payout approval QR.</p>}
    </>}
  </section>;
}
