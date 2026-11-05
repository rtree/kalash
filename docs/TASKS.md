# KALASH current work

## Current goal

- Goal: M2, consent-based photo sharing and public temple boards.
- Success: camera/file selection -> local preview -> explicit consent -> private validated storage -> public consented board DTO -> owner/temple withdrawal -> immediate public removal and object deletion; verify point-based image sizing.
- Chain: Base Sepolia 84532 only; test tokens, not real-value settlement.
- Running URL: https://kalash-central-548318651344.asia-south1.run.app/temples/temple-01
- Cloud Run live revision `kalash-central-00009-hgk`, source `65cf51cee9a7c908c516d7aac7e4448b940d358e`; local URL remains read/API-capable with MINT_ENABLED=false.
- DonationVault `0x7a5b5ccc5410e1c9ad4fef8f40bf9786cb842073`; Stamp `0x853d271ed9461f4e56c449d8c2b7c83b410b4cbb`.
- Integration, shared documents, Git and deployment owner: primary Agent.
- Initial blocker resolved: real cloud configuration and funding available; Windows native chain tests moved to Cloud Build.
- Next action: user taps Allow on the Android camera prompt; verify live preview then capture locally and discard, with no upload. In MetaMask's in-app browser the app loads authenticated History and the photo controls; mobile Chrome/WC's VerifyWallet fails on unsupported `personal_sign`. Two newer wallet donations are already confirmed/minted; do not make a duplicate payment.
- Human requests: no M1 action remains. User selected one-time camera permission; still waiting for the physical Android Allow tap. User has one consented/published photo; any additional personal image requires separate consent. Paper-note attendance remains for M3.
- Three test-process donations plus two normal MetaMask donations and mints are verified; all cash hardware outcomes remain unverified.

## Goals and assignments

| ID | Goal | Owner / edit scope | Dependencies | State | Completion condition | Evidence / next step |
|---|---|---|---|---|---|---|
| M1-entry | M1 | Integrator: AGENTS, docs, package policy | none | verified | Input saved, entry commit pushed, preflight passes | Initial59a0f48 and checkpointdf6d6a7 published; remote df6d6a7 confirmed16:32Z; initial lock report539 packages, audit0 |
| M1-hosts | M1 | Integrator: host/config diagnosis | none | verified | Actual hosts, access and URLs recorded | Windows NodeWeb/Controller/ADB; Linux Cloud Build tests23pass; actual cloud auth verified; tools/agent/user-wait/async all exercised |
| M1-wallets | M1 | Integrator: private wallet bootstrap | M1-entry | verified | New role wallets protected, public addresses/budgets provided and balances checked | 14 new wallets; actual RPC each funded role 0.1 ETH, donor/temple1 each 5 USDC. Budgets remain original .01/.003/.003/.001 ETH, donor .20 USDC despite excess balance |
| M1-chain | M1 | Contract Agent: contracts, compile-contracts.mjs, contracts.test.mjs, contracts.abi.json | M1-entry, M1-wallets | verified | Limits, fees, authorization, duplicate defense tested; real deployment | Linux24pass including corrected policy CLI regression; actual deployment receipts and23 isolated chain assertions verified |
| M1-api | M1 | Integrator: Central/Auth/Firestore | M1-entry | verified | Real authorization, intent, receipt, atomic persistence and mint verified locally and Cloud Run | Cloud7/local8tests0skip; 3real .01 donations/mints; exact points30000; real runtime SA signing/DB/secret and idle mint proven |
| M1-ui | M1 | UI Agent: isolated scripts/e2e-browser.mjs; Integrator: src/web/shared/test integration | M1-api, M1-chain | verified | First detail/donate/Collection route reloads real results | User confirmed Connect, VerifyWallet, SpendingCap, tx, Central confirm and stamp; attached Collection shows 2 Lotus Courtyard stamps; History shows 2 minted |
| M1-deploy | M1 | Integrator: Cloud Run/config | M1-api, M1-ui | verified | Same commit HTTPS, SA, deep links, idle mint and policy verified | Delegated receipt fix built and deployed revision `kalash-central-00005-mcx`, health source `790575d4bf141f643532b2024ba94709547a2000`; real API6pass/0skip |
| M1-e2e | M1 | Integrator: tests, Android/MetaMask | M1-deploy | verified | Real MetaMask path and reload; all M1 outcomes evidenced | User confirmed full normal MetaMask path including cap, tx, Central confirmation and on-chain stamp. Firestore confirms donation `0x92ded6b9f9…` confirmed/minted, tx `0x1027f9b8063b…`, mint `0xa0a91bdc6bd1…`; direct chain stamp balance1. Prior delegated payment also reconciled/minted exactly once |
| M2 | M2 | Integrator: photos/board | M1-e2e | doing | Real save/consent/withdrawal and sizes verified | Photo API7pass/0skip; user photo published on temple-01. Camera now uses direct `getUserMedia`, deployed revision `00009-hgk`, Cloud Build `30b9c882-5915-44ac-b0ac-e625951feedc`; tapping Take a photo opens Android camera permission prompt. Waiting user Allow before checking preview. MetaMask in-app browser shows verified History/photo controls; mobile Chrome/WC failed VerifyWallet with unsupported `personal_sign`. No payment sent by agent. Two recent owner donations are confirmed/minted. Temple/operator withdrawal auth remains |
| M3 | M3 | Integrator: Windows Controller/ITL | M2 | todo | Real QR/cash/close/reconcile/stamp | ITL localhost root HTTP404 only; no authenticated/device verification |
| M4 | M4 | Integrator: settlement/payout | M3 | todo | Real fee/admin/full payout/reconciliation | No device commands sent |
| M5 | M5 | Integrator: onsite crypto | M4 | todo | Real ATM QR/payment/visit stamp on both screens | Not started |

## Goal-specific blockers

| Affected task | Observed fact | Next diagnosis | Human action / resume condition |
|---|---|---|---|
| M1 cloud | Required APIs, Firestore asia-south1, Firebase Web, runtime/build SAs and scoped secret rights created. ADC principal differed from CLI; scoped signing grant corrected. Runtime identity and Firebase custom-token signing verified on live revision | Google sign-in remains a later auth-role check; no M1 blocker | Reown configured in Secret Manager, never pasted |
| M1 chain/build | Windows ARM64 Ganache leveldown failed; browser fallback failed. User confirms no nested virtualization and authorizes Cloud Build | Compile with solc JS and run Ganache tests in Linux Cloud Build | Not a request for WSL/Docker installation |
| M1 wallet | Actual balances exceed requested budgets; no automatic budget increase | Persist/respect original budgets before every transaction | Funding no longer blocks M1 |
| M1 Android | User requested install; Google archive platform-tools_r37.0.1-win.zip SHA1 matched repository metadata; `adb devices -l` shows Samsung SM_S942Z device | Screenshot/inspect then one operation and API evidence | Real camera QR/MetaMask verification still pending |
| M3/M4 ITL | .NET 10.0.403; runtimes 8.0.33/10.0.14; protected GetAllCashDevices returns HTTP401 before authentication (expected protection, not invalid credentials) | Obtain safe credential source and authenticate later | Safe local credential path and hardware attendance later; not an M1 blocker |
| M2 Storage | `kalash-donation-photos` in asia-south1; uniform access, public access prevention enforced, soft-delete 0; runtime SA objectAdmin application grant. Synthetic API photo was removed; user's consented temple-01 image remains published | Verify direct camera preview on Android and user can find Collection → Photos / temple board | No second image upload without explicit consent |

## Evidence retained

- Checkpoints `df6d6a7` and public-build source `eb7599e` published; remote hashes checked. External WIP checkpoints are preserved, not reset or amended.
- Latest `pnpm audit`: zero known vulnerabilities; six stale GitHub Dependabot alerts are closed/fixed after Sharp upgrade. Optional wallet SDK peer warnings remain; normal MetaMask PC donation and stamp flow verified.
- Actual Cloud Build `a8edc91e-655f-4fd3-9213-24ed913ba4b6`: SUCCESS, isolated chain 23 tests passed, zero skipped/failed. Evidence `artifacts/contracts-cloud-build.log` and cloud logs. This is not testnet donation evidence.
- Real deployments succeeded: vault tx `0x7377f2b6b10fe35f9baf3680f1a827829cab609b6e6c1af83790d1f930a968ec`, block54871753; stamp tx `0x02b3d8f17b64dd27c296799f7bd22d2f96c33adcfbad473f9064b0ec3041eb96`, block54871769. See config/deployment.public.json.
- First real donation `0xa0335880c2902420bf92daf1b3ed8429697571bd67d0cf8361f2a3b89cfd5003`: tx `0xb2d660ff5b2c528550ec84a1942d69c8da1e7202ebfced60bfeb1c5368f49e5c`, mint `0x81aff92eac9df043a05557968ae0f27b09cc4b747b25c5d3ed6ca9e9ccaa20b5`;16:35:34.818 intent ->16:35:43.463 confirmed ->16:35:49.193 minted.
- Second real donation `0x66b1027ec636fc2386fbb425f3f5d61cebd89becbb986babe19bf3b3830c389c`: tx `0xafff1f02d944a6643ba4974edf79a98bbaf0f16501f63ea3613680588fdbc5bc`, mint `0xed77de0ee2506c93d25222f022c659c3c4bc808d7de244b70c062e0f86986f1d`;16:39:52.584 ->16:40:02.221 ->16:40:07.898. Central discovered transaction by donationId with NO hash hint; exact cumulative20000 point units (2points), two distinct minted records.
- Both transactions were signed by the bounded test process, NOT normal MetaMask/browser evidence. Repeated verification/reload did not resend or add points.
- Cloud real API mandatory7pass0skip; local8pass including policy CLI regression: auth/nonce/signature/origin/ownership, cap/precision, unknown operation dedupe, exact points. Firebase client Firestore access denied403 with valid ID token. Actual deny-all rules release created; ten demo temple records bootstrapped without changing wallets.
- Browser CSP initially blocked Reown domains/fonts and optional telemetry inline script. Corrected endpoint allowlist/HEAD/favicon; UI disabled optional Coinbase/Base/smart-auth. Optional inline telemetry remains blocked; protection is not weakened.
- Visual evidence actually opened: artifacts/pilgrim-first-detail.png and artifacts/android-first-detail.png. Old screenshot precedes INR/map update. Android authorized Chrome CDP reached wallet chooser; no biometric screens captured.
- Observed: Node 26.13.0 published 2026-10-28, pnpm 10.34.9 published 2026-10-25T17:54:00.645Z; both older than 168h.
- Agent execution: diagnostic and contract Agents executed. Long command completed asynchronously and output was retrieved. Structured user-wait returned project/region and host decisions.
- Remaining untested: Google/email E2E roles, Android in-app MetaMask/camera QR, cash/payout/onsite flows, real user-selected photo and temple/operator withdrawal authorization. Both PC MetaMask donations and Collection/History stamp results are confirmed; no further donation is needed.

## Previous checkpoint (M1 wallet investigation)

- UTC2026-11-05T17:52:17Z, approximately117minutes. Tasks M1-ui/M1-e2e; actual QR/MetaMask SIWE succeeded, amount units fixed and deployed; authenticated reload failed and root hydration fix is being integrated.
- Live cloud `7f1d89aa1055` / revision00004-jdg. Build `e5326fa8-5f4a-41ff-9f03-5692b2b02b36` succeeded with Linux contract/policy and production unit gates. Earlier corrected-gate actual logs remain in artifacts/diagnostic-cloud-build.log. Most recent public mandatory API+policy/money8tests passed on42048b5; new unit regression makes next full suite9tests.
- Third test-signer donation `0x9c0a6ff6bd393355d3487e448723267cc8d3059d73c992d930099a5a2feb3851`: tx `0x29a1f0634ddcc0b63f11fe8c05a212ae4f125a64c690ec34bd7942672788aded`, mint `0x61950fce41f468b4de637b0d1230540d8e537aca89021b5374309e946e8fbfb3`. Confirmed16:52:52.317; DB job mintedAt16:52:55.988; first client observation16:53:07.465. Cloud request logs show no app requests16:52:53-16:53:03. Exact total30000 point units; reload across hosts passed without resending.
- Policy CLI used an incorrect file URL equality on Linux (`file:////...`), so direct CLI gate could be a no-op there despite explicit install restrictions. Fixed using pathToFileURL(resolve(argv1)); negative regression now passed in Linux and deployed. Current report539versions17:01:12Z.
- Normal Chrome/WalletConnect: fresh canonical-origin connection approved after human unlock; Wagmi still disconnected. Sanitized Chrome logs identify relay WebSocket ERR_NAME_NOT_RESOLVED. OS DNS resolves both official relays; later unauthenticated Chrome WebSocket probes reached their authentication rejection (network reachable at probe time, not session success). Do not attribute this to CSP or credentials without further evidence.
- The default Connect MetaMask button chose a registered injected connector even in Chrome without a provider, producing immediate Provider not found. Fixed selection to await actual provider presence and otherwise use configured AppKit. Typecheck passed; actual same Android button on source42048b5 now opens AppKit rather than failing.
- New Android Chrome attempt4519e3d4 used metamask://wc (sanitized scheme/host only verified), but no connection request appeared after unlock; no blanket storage wipe or SDK change. PC integrated-browser QR alternative was offered, human selected it and explicitly confirmed actually scanning the QR with MetaMask. AppKit/Wagmi walletConnect connected at17:30:52Z, initially chain1; injectedMetaMask=false. QR credential itself is not photographed, logged or committed.
- Base Sepolia SIWE reached the real MetaMask request. Review alert explicitly said Malicious site; Agent inspected and did not acknowledge it. Human independently operated the warning and requested a fresh SIWE. First returned signature was rejected NONCE_EXPIRED; new challenge was manually signed and Firebase login succeeded17:40Z. This does not resolve or declare the warning a false positive. Only an account-free warning crop is retained; private account screenshots deleted.
- Before donation, found four UI conversions wrongly treating API amount10000units as decimal10000USDC. Fixed approval/donate with strict parseDonationUnits and pending/history formatting directly from units. Exact response/wallet/display regression, visible SIWE expiry/rejection and duplicate verification guard now deployed in7f1d89a.
- Actual normal-wallet reload failed to restore authenticated UI: Firebase currentUser loads asynchronously, but old effect watched only address/auth object. Fixed onAuthStateChanged subscription, connector-hydration guard, verified Firebase UID/current-wallet match and initial missing-provider handling; local3tests/typecheck/build pass. Also forbid reuse of mismatched-amount or expired intents. Do not claim reload verified until deployed and repeated.
- Test browser script reached actual SIWE and intent43e1d254... but old units UI stopped before any wallet operation; deadline17:46:31Z passed with no operations/hashes. Progress4intents/.04USDC reserved, original6hashes unchanged. UI Agent is adding explicit proof-checked expired-unsubmitted resolution without deleting progress, marking a donation completed or refunding budget; execute only after auth fix deployment.
- Separate MetaMask injected-browser deep link showed harmful-site warning. Honored Back to safety; no proceed-anyway or disabled protection. Static MetaMask public blacklist/allowlist hostname/suffix check returned no match; warning domain not proven from screen, so not declared a false positive. Exact browser navigation needs confirmation.
- User added public canonical origin to Reown. Firebase already allows it. Remaining optional SDK inline analytics blocked by strict CSP, not silently allowed.
- Actual public OSM map10pins and390px layout screenshot opened: artifacts/public-explore-map.png. Wallet balance screenshot was deleted after inspection; no secrets/QR credentials added to shared records.
- Next action: deploy hydration fix, verify real authenticated reload, then execute the one explicitly authorized .01 donation and verify durable mint/Collection. Separate browser E2E must resolve only the proven never-submitted expired intent with an explicit guard before its one bounded new donation. No production signing key/public signer. M1 not complete; M2-M5 remain required.

## M1 delegated receipt update

- 2026-11-06T04:00+09:00: User shared Blockscout details for the already-paid
  MetaMask transaction. Direct read-only Base Sepolia receipt verification confirms
  outer `redeemDelegations` execution, status success, block54906036, exactly one
  configured DonationVault `Donated` event for the existing donation ID and wallet,
  amount10000/fee1/registered temple recipient, and exactly two donor-originating
  configured USDC transfers (1 fee + 9999 temple). No second payment was sent.
  Central direct-EOA assumptions were root cause. Local fix preserves strict direct
  sender/target/calldata validation and adds delegated-path exact event + on-chain
  fee-recipient + complete donor USDC-transfer verification before atomic idempotent
  confirmation. Added three focused tests (3 pass, 0 skipped); typecheck passes.
  Not yet deployed or reconciled in Firestore; next: include focused tests in image,
  run cloud build gate, deploy and have owner verify this same tx/donation through
  Central, then verify mint/Collection. Do not clear any records or resend.
- 2026-11-05T19:18Z: Fix `790575d` passed Cloud Build `f3e998a9-6fd2-4af7-949a-bf1dfceeca85`
  (contract + image gates incl. donation-receipt tests) and real-Central API 6pass/0skip;
  deployed revision `kalash-central-00005-mcx`, health sourceCommit verified.
  Operator ran the same `verifyDonation` once for donation `0x52bf6750...99ea4` with tx
  `0xbb22b84e...17da`: submitting -> confirmed, one mint job reserved, Cloud Run loop
  minted tx `0xb848936a01bc7c3d25a93d60b5e8eedd95092a12d6c99bc9cdcbc68076f75b4b`
  (block54922071, success), on-chain stamp balance 1, temple-01 points 10000 units for
  that wallet. No data cleared, no resend. First normal MetaMask (delegated) donation
  path was verified end-to-end on chain/DB.
- 2026-11-05T19:21Z / user confirmation 2026-11-06T04:29+09:00: user completed the
  second normal MetaMask path: Connect, VerifyWallet, SpendingCap, transaction,
  Central confirmation and stamp all succeeded. Firestore donation `0x92ded6b9f9…`
  is confirmed/minted (donation tx `0x1027f9b8063b…`, mint tx `0xa0a91bdc6bd1…`);
  direct Base Sepolia `balanceOf` is 1. User screenshots show two collected stamps
  and two minted History entries. M1 end-to-end complete; no further M1 payment
  requested or initiated.

## M2 implementation checkpoint

- 2026-11-06T06:20+09:00: sharp 0.34.5 initially exposed three new high advisories.
  Stopped deployment; upgraded to patched sharp 0.35.5 (published 2026-09-27, >168h)
  with pnpm install scripts disabled. The lockfile changes are limited to Sharp and
  its platform binaries; all 569 releases and lock hash verified; `pnpm audit` now
  reports zero known vulnerabilities. Photo processor enforces JPEG/PNG/WebP input, byte/pixel/page bounds,
  EXIF orientation, metadata-free 1600px JPEG output, and four integer-point tiers.
- Private bucket `kalash-donation-photos` is in asia-south1 with uniform access,
  public access prevention and zero-second soft delete; Cloud Run runtime SA is
  granted objectAdmin on this bucket. The synthetic API test object was cleaned up;
  the user later published one photo to temple-01.
- Implemented confirmed-donation eligibility, explicit-versioned-consent upload,
  one latest wallet/temple slot, 30-day expiry, same-origin private-object board
  delivery, owner withdrawal, and durable object cleanup/expiry queues. Public DTO
  excludes wallet, donation, points and storage object path. Pilgrim donation,
  History, Collection Photos and public temple-board UI wired.
- Local policy, typecheck, production build and 9 focused tests pass. API Cloud Build
  `a80fc3f1-a8d0-4311-8271-66a32f4daac0` succeeded. Camera Cloud Build
  `30b9c882-5915-44ac-b0ac-e625951feedc` succeeded. Live revision `kalash-central-00009-hgk`
  source `65cf51cee9a7c908c516d7aac7e4448b940d358e`, `PHOTO_BUCKET` verified.
  Mandatory live API tests 7pass/0skip include synthetic portrait, consent rejection,
  private proxy delivery, replacement/old-image 404, cross-wallet withdrawal denial,
  owner withdrawal and post-withdrawal 404. GCS bucket has no remaining test objects;
  public board returns an empty list after test cleanup.
- Browser inspection of `/board/temple-01` shows Lotus Courtyard, the empty-board state
  and intact navigation. No visible UI defect; the optional inline Reown script remains
  blocked by strict CSP and reports one console error. Do not weaken CSP for telemetry.
  No open Dependabot alerts remain after the Sharp patch; `pnpm audit` reports zero.
- User confirms photo registration. Firestore slot is `published`, size tier1, expiry
  2026-12-05; matching private object exists and the public board lists exactly one
  photo. No image bytes/name were read or logged.
- Mobile device `RFGL41GKP0Z` is authorized (`device`), Samsung SM_S942Z, Android16,
  1080x2340 and awake; foreground was Launcher. Chrome and MetaMask packages exist.
  ADB opened mobile Chrome on `/temples/temple-01`; Connect succeeded, the address
  appeared, and VerifyWallet failed with `personal_sign` unavailable (`viem@2.57.13`).
  No signature or payment was approved. The documented MetaMask DApp deeplink opened
  the in-app browser; it shows the KALASH page with History/Collection controls and
  no VerifyWallet button. History exposes Share a photo / Take a photo / Choose image.
  Tapping Take a photo called getUserMedia and raised Android's Allow permission prompt.
  User chose `allow_once` in chat, but the phone-side Allow tap/preview is not yet confirmed.
  Firestore shows two recent owner donations (21:40Z, 21:43Z)
  already `confirmed` and `minted`; neither was initiated by this agent. No third
  transaction will be sent. Next: verify camera preview after the user grants permission;
  stop at any further signature/payment prompt until explicit user action.
  Temple/operator withdrawal auth and cash-device photo intake remain; do not mark M2 complete.

## Submission

Not complete. Commands, public addresses, evidence IDs, deployed revision and outstanding
actions will be updated here as actual results become available.
