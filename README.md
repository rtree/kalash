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