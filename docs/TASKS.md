# KALASH current work

## Current goal

- Goal: M1, first real remote donation vertical slice, then full M1.
- Success: temple detail -> 0.01 test USDC -> Central durable verification -> real mint -> Collection reload.
- Chain: Base Sepolia 84532 only; test tokens, not real-value settlement.
- Running URL: `http://localhost:3000/temples/temple-01`; actual cloud Auth/DB/RPC. Local mint loop disabled before Cloud Run handover; no pending real mint jobs.
- Public Cloud Run URL: not assigned. DonationVault `0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`; Stamp `0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`.
- Integration, shared documents, Git and deployment owner: primary Agent.
- Initial blocker resolved: real cloud configuration and funding available; Windows native chain tests moved to Cloud Build.
- Next action: build/deploy this checkpoint to Cloud Run, verify runtime SA and real Android MetaMask.
- Human requests: none outstanding for initial funding/Reown/ADB; MetaMask and later paper-note attendance remain.
- No real donation, cloud deployment, mint or hardware outcome is verified.

## Goals and assignments

| ID | Goal | Owner / edit scope | Dependencies | State | Completion condition | Evidence / next step |
|---|---|---|---|---|---|---|
| M1-entry | M1 | Integrator: AGENTS, docs, package policy | none | verified | Input saved, entry commit pushed, preflight passes | Initial59a0f48 and checkpointdf6d6a7 published; remote df6d6a7 confirmed16:32Z; current lock report539 packages, audit0 |
| M1-hosts | M1 | Integrator: host/config diagnosis | none | verified | Actual hosts, access and URLs recorded | Windows NodeWeb/Controller/ADB; Linux Cloud Build tests23pass; actual cloud auth verified; tools/agent/user-wait/async all exercised |
| M1-wallets | M1 | Integrator: private wallet bootstrap | M1-entry | verified | New role wallets protected, public addresses/budgets provided and balances checked | 14 new wallets; actual RPC each funded role 0.1 ETH, donor/temple1 each 5 USDC. Budgets remain original .01/.003/.003/.001 ETH, donor .20 USDC despite excess balance |
| M1-chain | M1 | Contract Agent: contracts, compile-contracts.mjs, contracts.test.mjs, contracts.abi.json | M1-entry, M1-wallets | doing | Limits, fees, authorization, duplicate defense tested; real deployment | Windows ganache leveldown incompatible, browser fallback failed; compile here, execute chain tests in Cloud Build Linux |
| M1-api | M1 | Integrator: Central/Auth/Firestore | M1-entry | doing | Real authorization, intent, receipt, atomic persistence and mint verified locally and Cloud Run | Local mandatory7tests pass0skip; 2real .01 donations/mints; exact points20000; cloud runtime still pending |
| M1-ui | M1 | UI Agent batch complete; Integrator validates src/web/build | M1-api, M1-chain | doing | First detail/donate/Collection route reloads real results | Typecheck/build pass; 390px detail screenshot actually viewed; actual Android detail viewed; normal MetaMask browser donation pending |
| M1-deploy | M1 | Integrator: Cloud Run/config | M1-api, M1-ui | todo | Same commit HTTPS, SA, deep links, idle mint verified | GCP selection required |
| M1-e2e | M1 | Integrator: tests, Android/MetaMask | M1-deploy | doing | Real MetaMask path and reload; all M1 outcomes evidenced | ADB screenshot viewed and matching KALASH Chrome CDP tab controlled; phone AppKit wallet chooser ready; no normal MetaMask signature/payment yet |
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

- UTC: 2026-11-05T16:45Z (approximately 50 min after start; checkpoint delayed during real chain/API/rules tests).
- Tasks: M1-api/M1-ui/M1-deploy/M1-e2e; SDD reconciled, M1 design additions below.
- Version: working checkpoint being committed for first public build. Previous checkpoint `df6d6a7` published and remote hash confirmed.
- Current lock report: 539 registry releases at16:33:12Z; audit zero vulnerabilities all severities. Zod4 override built/typechecked; optional wallet SDK peer warnings remain, real MetaMask runtime pending.
- Actual Cloud Build `a8edc91e-655f-4fd3-9213-24ed913ba4b6`: SUCCESS, isolated chain 23 tests passed, zero skipped/failed. Evidence `artifacts/contracts-cloud-build.log` and cloud logs. This is not testnet donation evidence.
- Real deployments succeeded: vault tx `0x7377f2b6b10fe35f9baf3680f1a827829cab609b6e6c1af83790d1f930a968ec`, block54871753; stamp tx `0x02b3d8f17b64dd27c296799f7bd22d2f96c33adcfbad473f9064b0ec3041eb96`, block54871769. See config/deployment.public.json.
- First real donation `0xa0335880c2902420bf92daf1b3ed8429697571bd67d0cf8361f2a3b89cfd5003`: tx `0xb2d660ff5b2c528550ec84a1942d69c8da1e7202ebfced60bfeb1c5368f49e5c`, mint `0x81aff92eac9df043a05557968ae0f27b09cc4b747b25c5d3ed6ca9e9ccaa20b5`;16:35:34.818 intent ->16:35:43.463 confirmed ->16:35:49.193 minted.
- Second real donation `0x66b1027ec636fc2386fbb425f3f5d61cebd89becbb986babe19bf3b3830c389c`: tx `0xafff1f02d944a6643ba4974edf79a98bbaf0f16501f63ea3613680588fdbc5bc`, mint `0xed77de0ee2506c93d25222f022c659c3c4bc808d7de244b70c062e0f86986f1d`;16:39:52.584 ->16:40:02.221 ->16:40:07.898. Central discovered transaction by donationId with NO hash hint; exact cumulative20000 point units (2points), two distinct minted records.
- Both transactions were signed by the bounded test process, NOT normal MetaMask/browser evidence. Repeated verification/reload did not resend or add points.
- Real API mandatory tests7pass0skip: auth/nonce/signature/origin/ownership, cap/precision, unknown operation dedupe, exact points; Firebase client Firestore access denied403 with valid ID token. Actual deny-all rules release created; ten demo temple records bootstrapped without changing wallets.
- Browser CSP initially blocked Reown domains/fonts and optional telemetry inline script. Corrected endpoint allowlist/HEAD/favicon; UI disabled optional Coinbase/Base/smart-auth. Remaining inline runtime check and public HTTPS still pending.
- Visual evidence actually opened: artifacts/pilgrim-first-detail.png and artifacts/android-first-detail.png. Old screenshot precedes INR/map update. Android authorized Chrome CDP reached wallet chooser; no biometric screens captured.
- Observed: Node 26.13.0 published 2026-10-28, pnpm 10.34.9 published 2026-10-25T17:54:00.645Z; both older than 168h.
- Agent execution: diagnostic and contract Agents executed. Long command completed asynchronously and output was retrieved. Structured user-wait returned project/region and host decisions.
- Untested: normal MetaMask/browser donation+Collection, Google/email E2E roles, Cloud Run runtime/idle mint, camera QR, all cash/payout/photos/onsite flows. Next: public deployment and actual MetaMask.

## Submission

Not complete. Commands, public addresses, evidence IDs, deployed revision and outstanding
actions will be updated here as actual results become available.
