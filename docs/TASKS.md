# KALASH current work

## Current goal

- Goal: M1, first real remote donation vertical slice, then full M1.
- Success: temple detail -> 0.01 test USDC -> Central durable verification -> real mint -> Collection reload.
- Chain: Base Sepolia 84532 only; test tokens, not real-value settlement.
- Running version / URL: Central code in progress; planned local `http://localhost:3000`.
- Public Cloud Run URL: not assigned. DonationVault `0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`; Stamp `0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`.
- Integration, shared documents, Git and deployment owner: primary Agent.
- Initial blocker resolved: real cloud configuration and funding available; Windows native chain tests moved to Cloud Build.
- Next action: run Central and mandatory real API tests; complete first UI route and actual donation/mint/reload.
- Human requests: none outstanding for initial funding/Reown/ADB; MetaMask and later paper-note attendance remain.
- No real donation, cloud deployment, mint or hardware outcome is verified.

## Goals and assignments

| ID | Goal | Owner / edit scope | Dependencies | State | Completion condition | Evidence / next step |
|---|---|---|---|---|---|---|
| M1-entry | M1 | Integrator: AGENTS, docs, package policy | none | doing | Input saved, entry commit pushed, preflight passes | Repository initially README/docs only; no product code |
| M1-hosts | M1 | Integrator: host/config diagnosis | none | doing | Actual hosts, access and URLs recorded | Windows ARM64; Node/pnpm confirmed; diagnostic Agent executed |
| M1-wallets | M1 | Integrator: private wallet bootstrap | M1-entry | verified | New role wallets protected, public addresses/budgets provided and balances checked | 14 new wallets; actual RPC each funded role 0.1 ETH, donor/temple1 each 5 USDC. Budgets remain original .01/.003/.003/.001 ETH, donor .20 USDC despite excess balance |
| M1-chain | M1 | Contract Agent: contracts, compile-contracts.mjs, contracts.test.mjs, contracts.abi.json | M1-entry, M1-wallets | doing | Limits, fees, authorization, duplicate defense tested; real deployment | Windows ganache leveldown incompatible, browser fallback failed; compile here, execute chain tests in Cloud Build Linux |
| M1-api | M1 | Integrator: Central/Auth/Firestore | M1-entry | doing | Real authorization, intent, receipt, atomic persistence and mint verified | ADC SecretManager/Firestore/RPC/custom-token signing actually succeeded after correcting ADC-vs-CLI principal grant |
| M1-ui | M1 | UI Agent: src/web, public, scripts/build.mjs | M1-api, M1-chain | doing | First detail/donate/Collection route reloads real results | No seeded donation history; contract/API types shared |
| M1-deploy | M1 | Integrator: Cloud Run/config | M1-api, M1-ui | todo | Same commit HTTPS, SA, deep links, idle mint verified | GCP selection required |
| M1-e2e | M1 | Integrator: tests, Android/MetaMask | M1-deploy | todo | Real MetaMask path and reload; all M1 outcomes evidenced | Official checksum-verified ADB37.0.1 installed outside repo; Samsung device authorized; no phone screen inspected yet |
| M2 | M2 | Integrator: photos/board | M1-e2e | todo | Real save/consent/withdrawal and sizes verified | Not started |
| M3 | M3 | Integrator: Windows Controller/ITL | M2 | todo | Real QR/cash/close/reconcile/stamp | ITL localhost root HTTP404 only; no authenticated/device verification |
| M4 | M4 | Integrator: settlement/payout | M3 | todo | Real fee/admin/full payout/reconciliation | No device commands sent |
| M5 | M5 | Integrator: onsite crypto | M4 | todo | Real ATM QR/payment/visit stamp on both screens | Not started |

## Goal-specific blockers

| Affected task | Observed fact | Next diagnosis | Human action / resume condition |
|---|---|---|---|
| M1 cloud | Required APIs, Firestore asia-south1, Firebase Web, runtime/build SAs and scoped secret rights created. ADC principal differed from CLI; scoped signing grant corrected | Deploy same commit and test actual runtime SA; Google sign-in still pending | Reown configured in Secret Manager, never pasted |
| M1 chain/build | Windows ARM64 Ganache leveldown failed; browser fallback failed. User confirms no nested virtualization and authorizes Cloud Build | Compile with solc JS and run Ganache tests in Linux Cloud Build | Not a request for WSL/Docker installation |
| M1 wallet | Actual balances exceed requested budgets; no automatic budget increase | Persist/respect original budgets before every transaction | Funding no longer blocks M1 |
| M1 Android | User requested install; Google archive platform-tools_r37.0.1-win.zip SHA1 matched repository metadata; `adb devices -l` shows Samsung SM_S942Z device | Screenshot/inspect then one operation and API evidence | Real camera QR/MetaMask verification still pending |
| M3/M4 ITL | .NET 10.0.403; runtimes 8.0.33/10.0.14; protected GetAllCashDevices returns HTTP401 before authentication (expected protection, not invalid credentials) | Obtain safe credential source and authenticate later | Safe local credential path and hardware attendance later; not an M1 blocker |

## Latest checkpoint

- UTC: 2026-11-05T16:32Z (approximately 37 min after start; checkpoint delayed during API implementation).
- Tasks: M1-wallets/M1-chain/M1-api; SDD sections 1-5 reconciled with runtime, ABI and persistence implementation.
- Version: working checkpoint being committed; no running product yet. External WIP commits `9f34a4c`, `a9239ce` observed (not reset/amended).
- Initial Push HTTP500 recovered externally: remote main equals `a9239ce` when checked at 16:24Z; own next checkpoint will verify publication.
- Current lock report: 540 registry releases at 16:18:15Z. Audit reduced to two high Zod3 paths; compatibility remediation in progress, not waived.
- Actual Cloud Build `a8edc91e-655f-4fd3-9213-24ed913ba4b6`: SUCCESS, isolated chain 23 tests passed, zero skipped/failed. Evidence `artifacts/contracts-cloud-build.log` and cloud logs. This is not testnet donation evidence.
- Real deployments succeeded: vault tx `0x7377f2b6b10fe35f9baf3680f1a827829cab609b6e6c1af83790d1f930a968ec`, block54871753; stamp tx `0x02b3d8f17b64dd27c296799f7bd22d2f96c33adcfbad473f9064b0ec3041eb96`, block54871769. See config/deployment.public.json.
- Observed: Node 26.13.0 published 2026-10-28, pnpm 10.34.9 published 2026-10-25T17:54:00.645Z; both older than 168h.
- Agent execution: diagnostic and contract Agents executed. Long command completed asynchronously and output was retrieved. Structured user-wait returned project/region and host decisions.
- Untested: product donation, API mandatory tests, actual mint/Collection, Google, Cloud Run, MetaMask, hardware. Next: Central/API tests then first real donation route.

## Submission

Not complete. Commands, public addresses, evidence IDs, deployed revision and outstanding
actions will be updated here as actual results become available.
