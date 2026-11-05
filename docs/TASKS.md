# KALASH current work

## Current goal

- Goal: M1, first real remote donation vertical slice, then full M1.
- Success: temple detail -> 0.01 test USDC -> Central durable verification -> real mint -> Collection reload.
- Chain: Base Sepolia 84532 only; test tokens, not real-value settlement.
- Running version / URL: none; planned local `http://localhost:3000`.
- Public Cloud Run URL / deployed contracts: not assigned / not deployed.
- Integration, shared documents, Git and deployment owner: primary Agent.
- Initial blockers: no GCP project selected; no assigned Linux host; wallet funding pending generation.
- Next action: save full SPEC, commit/push entry documents; enforce dependency policy before acquisition.
- Human requests: generated addresses and exact budgets will follow; do not paste secrets.
- No real donation, cloud deployment, mint or hardware outcome is verified.

## Goals and assignments

| ID | Goal | Owner / edit scope | Dependencies | State | Completion condition | Evidence / next step |
|---|---|---|---|---|---|---|
| M1-entry | M1 | Integrator: AGENTS, docs, package policy | none | doing | Input saved, entry commit pushed, preflight passes | Repository initially README/docs only; no product code |
| M1-hosts | M1 | Integrator: host/config diagnosis | none | doing | Actual hosts, access and URLs recorded | Windows ARM64; Node/pnpm confirmed; diagnostic Agent executed |
| M1-wallets | M1 | Integrator: private wallet bootstrap | M1-entry | todo | New role wallets protected, public addresses/budgets provided | No preexisting wallets assumed |
| M1-chain | M1 | Integrator: contracts and chain tests | M1-entry, M1-wallets | todo | Limits, fees, authorization, duplicate defense tested; real deployment | Linux unavailable; test pure-JS compatibility without native tool assumptions |
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
| M1 cloud | Explicit gcloud path works. `kalash-donation` and `aireceptionist-510301` visible; ADC file exists but auth unverified | Ask project/region, then inspect APIs/IAM/ADC | Confirm project and region |
| M1 chain/build | Windows ARM64; no WSL distro; Docker daemon not confirmed | Minimal pure-JS compile/local-chain probe, otherwise assigned Linux host | Provide supported host/access if needed |
| M1 wallet | Wallets not generated yet | Generate after verified dependency setup, request exact role funding | Fund listed Base Sepolia addresses only |
| M1 Android | adb missing in PATH/common SDK paths | Ask for SDK/USB host; do not claim phone verification | Attach authorized Android and provide installed adb location |
| M3/M4 ITL | .NET 10.0.403; runtimes 8.0.33/10.0.14; protected GetAllCashDevices returns HTTP401 before authentication (expected protection, not invalid credentials) | Obtain safe credential source and authenticate later | Safe local credential path and hardware attendance later; not an M1 blocker |

## Latest checkpoint

- UTC: 2026-11-05T16:04Z (approximately 9 min after start).
- Tasks: M1-entry/M1-hosts; SDD sections 1-6 established.
- Version: initial document commit `59a0f48` saved locally; no running product.
- Push failed: GitHub remote HTTP500 at 16:02Z; commit retained. Retry next checkpoint, no force push.
- Pre-acquisition policy passed on actual pnpm config. Exact dependency releases selected using registry publication timestamps; acquisition not yet run.
- Observed: Node 26.13.0 published 2026-10-28, pnpm 10.34.9 published 2026-10-25T17:54:00.645Z; both older than 168h.
- Agent execution: synchronous diagnostic task succeeded. Long-process and user-wait capabilities will be tested explicitly, not assumed.
- Untested: all product/API/chain/device flows. Next: policy preflight, dependency acquisition/release evidence, then wallet/bootstrap and first route.

## Submission

Not complete. Commands, public addresses, evidence IDs, deployed revision and outstanding
actions will be updated here as actual results become available.
