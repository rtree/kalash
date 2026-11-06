# KALASH

Base Sepolia test-token temple donations and nontransferable stamps.
Fictional demo temples are not affiliated with real temples.

Read [AGENTS.md](AGENTS.md), [SPEC](docs/SPEC.md), [current design](docs/SDD.md)
and [current verification / next action](docs/TASKS.md) before resuming.

## Local Central and Pilgrim

Use Node **26.13.0**, pnpm **10.34.9** and an authenticated ADC for
`kalash-donation`. Never paste secrets into commands, Git or chat.

```powershell
node scripts\check-policy.mjs
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
$env:GOOGLE_CLOUD_PROJECT = 'kalash-donation'
$env:GOOGLE_CLOUD_QUOTA_PROJECT = 'kalash-donation'
$env:PUBLIC_ORIGIN = 'http://localhost:3000'
$env:MINT_ENABLED = 'false'
pnpm run dev
```

Open `http://localhost:3000/temples/temple-01`.
Only one local/cloud mint loop may be enabled for the shared minter.
Enable `MINT_ENABLED=true` only on the designated active Central.
Firestore, Firebase Auth, Secret Manager and Base RPC are real services,
not local substitutes. Runtime configuration reads the Secret Manager names
`kalash-minter-key` and `kalash-reown-project-id` using ADC.
Public Firebase, wallet and deployment data are in `config/`.

With Central running, `pnpm test` runs mandatory real authorization/amount
tests; it fails rather than skips when services are unavailable.
`pnpm run e2e:remote` uses the ACL-protected dedicated donor test wallet,
persists transaction progress and resumes without resending completed donations.
`--new-donation` explicitly starts another capped 0.01 USDC test.
This script is not normal MetaMask browser evidence.

## Supported chain tests / cloud build

Windows ARM64 Ganache's native leveldown cannot run here. Compile with
`node scripts\compile-contracts.mjs`; execute chain tests in Linux Cloud Build:

```powershell
gcloud builds submit --config=cloudbuild.test.yaml --region=asia-south1 --project=kalash-donation --service-account=projects/kalash-donation/serviceAccounts/kalash-build@kalash-donation.iam.gserviceaccount.com
```

Cloud images acquire pinned pnpm from its registry tarball with SHA-512 and
168-hour verification, then check policy and install frozen/ignore-scripts.
No npm, download generator or install hook is used.
`cloudbuild.yaml` builds the single Central image with an explicit `_REVISION`.
Cloud Run deployment and verified URLs are recorded in TASKS.

Manufacturer files, keys, `.env`, device logs and photos must remain outside
Git and build contexts. Cash and payout features are not implied by M1.

## M3 ATM reception (cash acceptance disabled)

The deployed `/atm/atm-01` screen supports a short-lived MetaMask deeplink QR,
wallet-bound cash-reception consent and state restoration. It does **not** enable
the acceptor or confirm a cash donation. Never insert banknotes during this phase.
Onsite crypto remains disabled until M5. Photo withdrawal follow-up is deferred.

On the registered Windows Controller, using the existing ACL-protected
`%LOCALAPPDATA%\KALASH\secrets` directory and authorized ADC:

```powershell
node scripts\check-policy.mjs
$env:PUBLIC_ORIGIN = 'https://kalash-central-548318651344.asia-south1.run.app'
node scripts\bootstrap-atm.mjs
node scripts\pair-atm.mjs
```

Read the saved pairing code locally and enter it on `/atm/atm-01` within 120
seconds; do not share the code or credential file. A replacement pairing preserves
the reception and revokes the previous screen. Select Cash reception, scan the
QR with the phone's external reader, verify the displayed temple/ATM in MetaMask,
then explicitly sign reception consent. This is not a token approval or payment.
Closing this registration is allowed only before any cash command exists.

`pnpm run test:atm` includes real Central/Firebase/Firestore API tests (no skips),
isolated test ATMs/wallets, concurrency/expiry/authorization tests and injected
provider add-chain tests. It never uses the real acceptor or submits transactions.
Mobile QR checks use the deployed HTTPS origin, not development-PC localhost.