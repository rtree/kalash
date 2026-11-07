# KALASH

Base Sepolia test-token temple donations and nontransferable stamps.
Fictional demo temples are not affiliated with real temples.

Read [AGENTS.md](AGENTS.md), [SPEC](docs/SPEC.md), [current design](docs/SDD.md)
and [current verification / next action](docs/TASKS.md) before resuming.

### How it's Made

KALASH bridges a physical bill acceptor and a mobile, wallet-based donation
experience. The two key pieces are the NV200 Spectral's PC-accessible device
interface and a mobile flow that brings the KALASH page into MetaMask, where
the user's own wallet is already available.

#### NV200 bill validator

The NV200 Spectral connects to a Windows PC over USB. Instead of having the web
app talk to a serial device directly, KALASH uses the manufacturer's ITL
CashDevice REST API Server as the local hardware interface. KALASH's .NET
Windows Controller starts and communicates with that server over loopback;
the server in turn talks to the validator. The Controller reports device
readiness and cash-session events to KALASH Central over authenticated HTTPS.
This keeps the vendor-specific device protocol behind a local API and gives
the application a defined boundary for hardware status and operations.

Cash intake is treated as a stateful, reconciled operation rather than a
button that simply adds an amount. For a cash-enabled session, the Controller
reports note events in order; Central matches them to the active ATM session.
After the user finishes or the acceptance window closes, the device is stopped
and its inventory and counters are reconciled before the cash is confirmed.
Uncertain device outcomes are not treated as successful donations or blindly
retried. Cash acceptance is separately gated by Central and Controller
readiness; the current M5a onsite flow is Crypto-only, as described below.
See the [Cash Machine Controller guide](CashMachine/CashMachineController/README.md)
for the local process and safety boundaries.

#### MetaMask mobile deep link and in-app browser

Mobile wallet flows can be awkward when the dapp and signer live in separate
apps: a user may have to create or import a second wallet for an app, or switch
back and forth between a dapp browser and a wallet to approve requests. KALASH
uses MetaMask's DApp deep link to open its canonical HTTPS temple page in
MetaMask's built-in browser, alongside the user's existing wallet.

At an ATM, choosing Crypto creates a short-lived reception in Central and
displays a QR code containing the MetaMask link to that temple page. The phone
can scan it with its external QR reader; MetaMask opens the KALASH page with an
opaque reference to the pending reception. The phone and ATM both continue
through Central, so the phone does not connect directly to the ATM or Windows
Controller. An external mobile browser can also offer an **Open in MetaMask**
link.

The QR is an entry point, not permission to transact. Opening it does not
connect a wallet, join the reception, start cash acceptance, or send a payment.
The user reviews the temple and request, explicitly joins with a verified
wallet, and confirms each wallet action. For Crypto donations, any needed
token approval and the donation itself are distinct requests. MetaMask remains
the signer throughout; KALASH does not receive or store the user's private key.

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

`pnpm run test:cash` exercises the local cash HTTP routes, transaction store
doubles, ordered note ledger, Done reconciliation, atomic donation/mint
reservation and Crypto regressions. It must run nonzero tests with no skips;
it does not prove live Firestore, hardware acceptance or a minted stamp.
These tests also run in the Central image build.

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

## M5a onsite Crypto ATM (Cash disabled)

The deployed `/atm/atm-01` screen supports authorized screen pairing, a short-lived
MetaMask deeplink QR, explicit wallet/visit binding and Central state restoration.
Only Crypto is selectable. Cash remains disabled whether the Controller is offline,
the USB/NV200 is disconnected, or health is stale. Never insert banknotes during
this phase. The subsequent M3 goal will add actual Cash acceptance and reconciliation.
Photo withdrawal follow-up is deferred.

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
the reception and revokes the previous screen. Select Crypto donation, scan the
QR with the phone's external reader, verify the temple/ATM in MetaMask, verify the
wallet and explicitly join. Approval and donation remain separate wallet requests.
No CashDevice operation is called.

The registered Controller's `POST /api/controller/:atmId/health` endpoint accepts
sequenced, authenticated, read-only USB/open/start/routes/poller status. Report at
least every 10 seconds; a report older than 15 seconds or any missing readiness
condition makes the cash status offline/disconnected. Health reports never enable
cash during M5a.

`pnpm run test:atm` includes real Central/Firebase/Firestore API tests (no skips),
isolated test ATMs/wallets, concurrency/expiry/authorization tests and injected
provider add-chain tests. It never uses the real acceptor or submits transactions.
Mobile QR checks use the deployed HTTPS origin, not development-PC localhost.

## M3 cash product integration (physical operation off by default)

The Controller product path uses one device execution owner, durable note/dispatch
state and an ordered Outbox. Central stores matching note events and only confirms
cash after Done/deadline stopping and full inventory/counter reconciliation.
Confirmed cash uses INR and existing on-site stamps, not a Donation Vault payment.
The temple's 3% fee remains unpaid; product payout is not implemented by this path.

Both a registered Central ATM with cash enabled and the Controller's explicit
owner-attended product gate are required. Do not enable either merely to inspect
the UI or run tests. See the [Controller guide](CashMachine/CashMachineController/README.md)
and [current blockers](docs/TASKS.md) for the gate, local state recovery and the
separate real-note verification requirements. A Done click requests stopping;
it never clears unresolved cash or implies a donation by itself.