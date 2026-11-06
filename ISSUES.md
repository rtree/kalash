# M3-cash blockers

## M3-CASH-ACCOUNTING: define the cash donation settlement and stamp model

**Status:** Blocking safe cash acceptance and M3-cash completion.

The input SPEC defines a cash cap in INR/paise, INR-to-USDC point conversion,
cash donation confirmation, a cash fee contract responsibility, and an onsite
stamp. The current implementation cannot represent that settlement consistently:

- `contracts/DonationVault.sol` transfers USDC from the donor and rejects
  `kind > 1`; it cannot settle physical INR.
- `contracts/KalashStamp.sol` also rejects `kind > 1`.
- `src/shared.ts` and the donation/mint pipeline only model `kind: 0 | 1`.
- No `CashFeeVault` source, ABI, address, deployment record, or precise cash-fee
  contract is present in the repository.
- ATM/Central explicitly reject Cash visits, and no cash command/event ledger is
  implemented yet.

**Decision needed before accepting notes:**

1. Is a cash donation an off-chain INR liability with a later, separately
   authorized fee settlement, or must cash value/fees be represented on-chain at
   intake? Specify the recipient, fee amount/currency, settlement point, and
   recovery behavior.
2. Should cash use the existing onsite stamp kind (`1`) while retaining a
   separate cash method in the donation ledger, or should contracts and
   metadata gain a distinct cash kind? Do not relax the existing contract guards
   or infer a new kind without an explicit decision.
3. If `CashFeeVault` is required, provide its contract/interface, authorization,
   deployment, and settlement invariants.

**Until resolved:** keep the Cash button disabled; do not enable the acceptor,
insert notes, or create a cash donation/mint. M3 hardware Stage 1 and disabled
OpenConnection/readback/disconnect were verified separately; they do not prove
cash accounting or authorize acceptance.
