# KALASH current work

## Current goal

- Goal: M1, first real remote donation vertical slice, then full M1.
- Success: temple detail -> 0.01 test USDC -> Central durable verification -> real mint -> Collection reload.
- Chain: Base Sepolia 84532 only; test tokens, not real-value settlement.
- Running version / URL: none; planned local `http://localhost:3000`.
- Public Cloud Run URL / deployed contracts: not assigned / not deployed.
- Integration, shared documents, Git and deployment owner: primary Agent.
- Initial blockers: no GCP project selected; no assigned Linux host; wallet funding pending generation.
- Next action: finish dependency advisory remediation, implement first Central/UI route and compile contracts; run chain tests in Cloud Build Linux.
- Human requests: fund `config/wallets.public.json` addresses; set Reown ID in the newly created Secret Manager container; provide exact adb path (not secrets).
- No real donation, cloud deployment, mint or hardware outcome is verified.

## Goals and assignments

| ID | Goal | Owner / edit scope | Dependencies | State | Completion condition | Evidence / next step |
|---|---|---|---|---|---|---|
| M1-entry | M1 | Integrator: AGENTS, docs, package policy | none | doing | Input saved, entry commit pushed, preflight passes | Repository initially README/docs only; no product code |
| M1-hosts | M1 | Integrator: host/config diagnosis | none | doing | Actual hosts, access and URLs recorded | Windows ARM64; Node/pnpm confirmed; diagnostic Agent executed |
| M1-wallets | M1 | Integrator: private wallet bootstrap | M1-entry | human-wait | New role wallets protected, public addresses/budgets provided and balances checked | 14 wallets generated, ACL-restricted outside repository; public list/budgets in config/wallets.public.json; funding requested |
| M1-chain | M1 | Contract Agent: contracts, compile-contracts.mjs, contracts.test.mjs, contracts.abi.json | M1-entry, M1-wallets | doing | Limits, fees, authorization, duplicate defense tested; real deployment | Windows ganache leveldown incompatible, browser fallback failed; compile here, execute chain tests in Cloud Build Linux |
| M1-api | M1 | Integrator: Central/Auth/Firestore | M1-entry | todo | Real authorization, intent, receipt, atomic persistence and mint verified | Cloud project/ADC not yet verified |
| M1-ui | M1 | Integrator: React Pilgrim | M1-api, M1-chain | todo | First detail/donate/Collection route reloads real results | No seeded donation history |
| M1-deploy | M1 | Integrator: Cloud Run/config | M1-api, M1-ui | todo | Same commit HTTPS, SA, deep links, idle mint verified | GCP selection required |
| M1-e2e | M1 | Integrator: tests, Android/MetaMask | M1-deploy | todo | Real MetaMask path and reload; all M1 outcomes evidenced | ADB not in PATH |
| M2 | M2 | Integrator: photos/board | M1-e2e | todo | Real save/consent/withdrawal and sizes verified | Not started |
| M3 | M3 | Integrator: Windows Controller/ITL | M2 | todo | Real QR/cash/close/reconcile/stamp | ITL localhost root HTTP404 only; no authenticated/device verification |
| M4 | M4 | Integrator: settlement/payout | M3 | todo | Real fee/admin/full payout/reconciliation | No device commands sent |
| M5 | M5 | Integrator: onsite crypto | M4 | todo | Real ATM QR/payment/visit stamp on both screens | Not started |

## Goal-specific blockers

| Affected task | Observed fact | Next diagnosis | Human action / resume condition |
|---|---|---|---|
| M1 cloud | User selected kalash-donation / asia-south1. Required APIs enabled; Firestore created there; Firebase project ACTIVE; runtime/build SAs created | Verify ADC and runtime signing; create Firebase web app/config | Reown ID can be added to Secret Manager without chat |
| M1 chain/build | Windows ARM64 Ganache leveldown failed; browser fallback failed. User confirms no nested virtualization and authorizes Cloud Build | Compile with solc JS and run Ganache tests in Linux Cloud Build | Not a request for WSL/Docker installation |
| M1 wallet | Dedicated new role wallets generated; no chain balances checked yet | Query ETH/USDC and estimate gas before any send | Fund listed Base Sepolia addresses only |
| M1 Android | adb missing in PATH/common SDK paths | Ask for SDK/USB host; do not claim phone verification | Attach authorized Android and provide installed adb location |
| M3/M4 ITL | .NET 10.0.403; runtimes 8.0.33/10.0.14; protected GetAllCashDevices returns HTTP401 before authentication (expected protection, not invalid credentials) | Obtain safe credential source and authenticate later | Safe local credential path and hardware attendance later; not an M1 blocker |

## Latest checkpoint

- UTC: 2026-11-05T16:20Z (approximately 25 min after start; checkpoint delayed during dependency/auth diagnosis).
- Tasks: M1-entry/M1-hosts/M1-wallets/M1-chain; SDD sections 1 and 5 reconciled.
- Version: initial document commit `59a0f48` saved locally; no running product.
- Push failed: GitHub remote HTTP500 at 16:02Z; commit retained. Retry next checkpoint, no force push.
- Initial acquisition used ignore-scripts; 693 locked releases verified at 16:09:32Z. Audit found new dependency advisories; exact aged fixes selected, report will be regenerated before further dependency execution.
- Observed: Node 26.13.0 published 2026-10-28, pnpm 10.34.9 published 2026-10-25T17:54:00.645Z; both older than 168h.
- Agent execution: diagnostic and contract Agents executed. Long command completed asynchronously and output was retrieved. Structured user-wait returned project/region and host decisions.
- Untested: all product/API/chain/device flows. Next: policy preflight, dependency acquisition/release evidence, then wallet/bootstrap and first route.

## Submission

Not complete. Commands, public addresses, evidence IDs, deployed revision and outstanding
actions will be updated here as actual results become available.
