# M3-cash implementation notes

## M3-CASH-ACCOUNTING: resolved by the 2026-11-06 senior decision

Cash donations are an off-chain INR ledger. They do not call DonationVault and
do not transfer USDC from the donor. A confirmed cash donation receives the
existing onsite stamp (`kind: 1`); the ledger records `method: "cash"` and the
original INR/paise amount separately. Do not add a cash kind or weaken the
DonationVault/KalashStamp `kind <= 1` guards.

The temple owes a 3% USDC fee after intake. CashFeeVault/CashFeeCollector,
invoice/payment verification and payout belong to Stage C; absence of that
contract must not be hidden with a placeholder address or silently block the
Stage B cash-intake implementation. Keep unpaid fees explicitly unsettled.

## M3-CASH-STAGE-B: implementation and human gate

Implement the signed one-use wallet/ATM/cashSession binding, 500 INR cap,
120-second Ready-based acceptance window, single consuming poller, durable
ordered note/event journal, Central reconciliation, onsite stamp reservation,
and optional ATM photo authority. Unknown or mismatched events remain
`reconciling`; never invent a donation or auto-retry a cash command.

The cash button stays disabled until all Stage B code and mandatory tests pass
and fresh Controller readiness is authenticated. Physical banknote acceptance
then requires a separate explicit onsite authorization; test one 100/200 INR
note under owner attendance and reconcile Payout, counters and the cash ledger.
