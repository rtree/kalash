# M3-cash decisions and remaining scope

## M3-CASH-ACCOUNTING — resolved by senior decision (2026-11-06)

- Cash is an off-chain INR/paise ledger; physical cash never calls DonationVault
  and does not transfer USDC from the donor.
- A confirmed cash record uses `method: "cash"` and retains the original INR
  amount. It receives the existing onsite stamp (`kind: 1`); do not add a cash
  kind or weaken DonationVault/KalashStamp `kind <= 1` guards.
- The temple owes a 3% USDC fee after intake. CashFeeVault/CashFeeCollector,
  invoice/payment verification and payout are Stage C. Do not invent a
  deployment address or treat the fee as paid.

## M3-CASH-STAGE-B — implementation in progress

Implement a one-use signed wallet/ATM/cashSession binding, 500 INR cap,
120-second Ready-based acceptance window, single consuming poller, durable
ordered note/event journal, Central reconciliation, onsite stamp reservation,
and optional ATM photo authority. Unknown or mismatched events remain
`reconciling`; never invent a donation or automatically retry a cash command.

Keep the Cash button disabled until Stage B code and mandatory tests pass and
fresh Controller readiness is authenticated. Physical banknote acceptance then
requires explicit onsite authorization; test one 100/200 INR note under owner
attendance and reconcile Payout, counters and the cash ledger.
