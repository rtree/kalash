# kalash

An donation webApp that connect devotees and temple in confortable way. Devotees can donate cashes to temple by crypto remotely and also by notes using ATMs that are placed in temples.

<img width="503" height="381" alt="image" src="https://github.com/user-attachments/assets/7c75ad90-eb23-4a29-83b2-02efe8e25181" />


### How it's Made

KALASH bridges a physical bill acceptor and a mobile, wallet-based donation
experience. Its defining breakthrough is the NV200 Spectral: unlike most bill
validators, it can connect to a Windows PC over USB and be controlled through
the manufacturer's REST API. That unusually direct hardware-to-software path
is what made this project possible.

#### NV200 bill validator

The manufacturer's ITL CashDevice REST API Server exposes the USB-connected
validator to software on the Windows PC. KALASH's .NET Windows Controller
starts and communicates with that server over loopback; the server in turn
talks to the validator. The Controller reports device readiness and cash-session
events to KALASH Central over authenticated HTTPS. This keeps the vendor-specific
device protocol behind a local API and gives the application a defined boundary
for hardware status and operations.

```mermaid
flowchart LR
  subgraph PC["Windows PC"]
    Controller["KALASH .NET Cash Machine Controller"]
    REST["ITL CashDevice REST API Server"]
    Controller <-->|"Loopback REST API"| REST
  end
  REST <-->|"USB cable / serial device connection"| NV200["ITL NV200 Spectral Bill Validator"]
  Controller -->|"Authenticated HTTPS"| Central["KALASH Central"]
```

Cash intake is treated as a stateful, reconciled operation rather than a
button that simply adds an amount. For a cash-enabled session, the Controller
reports note events in order; Central matches them to the active ATM session.
After the user finishes or the acceptance window closes, the device is stopped
and its inventory and counters are reconciled before the cash is confirmed.
Uncertain device outcomes are not treated as successful donations or blindly
retried. Cash acceptance is separately gated by Central and Controller
readiness.
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

To build the link, start with the canonical HTTPS page for the temple. For an
active ATM reception, add its opaque reference as the `visit` query parameter:

```ts
const target = new URL(`/temples/${templeId}`, canonicalOrigin);
target.searchParams.set('visit', reference);
const deepLink =
  `https://link.metamask.io/dapp/${target.href.slice('https://'.length)}`;
```

For example, `https://<canonical-host>/temples/temple-01?visit=<reference>`
becomes
`https://link.metamask.io/dapp/<canonical-host>/temples/temple-01?visit=<reference>`.
Build the target URL first, validate that it uses the configured HTTPS origin
and an allowed temple path, then put its host, path and query after
`https://link.metamask.io/dapp/`. Do not URL-encode the entire target a second
time: that would encode its separators and prevent MetaMask from opening the
intended page. A normal temple link can omit the `visit` parameter. KALASH's
implementation is in [`src/atm.ts`](src/atm.ts), with URL-preservation and
rejection cases in [`tests/atm.test.ts`](tests/atm.test.ts).

The QR is an entry point, not permission to transact. Opening it does not
connect a wallet, join the reception, start cash acceptance, or send a payment.
The reference is for finding the pending reception, not a credential or payment
authorization; do not put wallet keys, session credentials or tokens in the
link. The user reviews the temple and request, explicitly joins with a verified
wallet, and confirms each wallet action. For Crypto donations, any needed token
approval and the donation itself are distinct requests. MetaMask remains the
signer throughout; KALASH does not receive or store the user's private key.

#### Architecture and communication boundaries

```mermaid
flowchart LR
  subgraph PilgrimDevice["Pilgrim device"]
    P["Pilgrim web app<br/>served by Central"]
    W["External wallet<br/>MetaMask or compatible wallet"]
    P <-->|"Reown AppKit / injected wallet provider"| W
  end

  subgraph AdminDevice["Temple administrator's device"]
    T["Temple Admin web app<br/>served by Central"]
    TW["Administrator's external wallet"]
    T <-->|"Wallet connection / signing"| TW
  end

  subgraph TemplePC["Temple Windows PC"]
    D["ATM Donate Screen<br/>browser app"]
    B["ATM Board Screen<br/>browser app"]
    H["KALASH Cash Machine Controller<br/>.NET 10 resident process"]
    I["ITL CashDevice REST API Server"]
    N["ITL NV200 Spectral + Spectral Payout"]
    H <-->|"Loopback REST API"| I
    I <-->|"USB / serial device connection"| N
  end

  subgraph Cloud["Google Cloud"]
    C["KALASH Central<br/>single Cloud Run service<br/>Web app + API + background loops"]
    FA["Firebase Authentication"]
    DB["Firestore<br/>application records and processing state"]
    SM["Secret Manager<br/>minter key and service configuration"]
    GCS["Private Cloud Storage<br/>photo objects"]
    C <-->|"Firebase Admin SDK<br/>custom tokens / ID-token verification"| FA
    C <-->|"Firestore Admin SDK<br/>Central is the application writer"| DB
    C -->|"ADC secret access"| SM
    C <-->|"Private object access"| GCS
  end

  CH["Base Sepolia testnet · chain ID 84532<br/>DonationVault · CashFeeVault · KalashStamp"]

  P <-->|"HTTPS: web app and same-origin APIs"| C
  T <-->|"HTTPS: web app and same-origin APIs"| C
  D <-->|"HTTPS: ATM reception and state APIs"| C
  B -->|"HTTPS: public board and image APIs"| C
  H <-->|"Controller-initiated HTTPS polling,<br/>health and event reports"| C
  P <-->|"Firebase Auth SDK<br/>Central-issued custom-token sign-in"| FA
  T <-->|"Firebase Auth SDK<br/>Central-issued custom-token sign-in"| FA
  W -->|"USDC approval and Crypto donation"| CH
  TW -->|"Cash-fee settlement when due"| CH
  C <-->|"Base Sepolia RPC<br/>verify receipts/events; submit stamp mints"| CH
```

- Central serves the browser applications and their same-origin APIs. The ATM
  screen submits reception requests to Central; Central authorizes and records
  work for the Controller. The Controller initiates HTTPS requests to poll for
  commands and report health, device events and results. There is no inbound
  Windows port, and browser screens do not connect directly to the Controller
  or the ITL REST API Server.
- Pilgrim and administrator wallets sign messages and blockchain transactions
  in the external wallet. Central verifies wallet sign-in and issues Firebase
  custom tokens; the browser uses the Firebase Auth SDK, while protected API
  requests are verified by Central. Authentication does not give the browser
  direct Firestore write access. The public Board Screen uses Central's public
  board APIs.
- Crypto donations are sent by the donor wallet to `DonationVault`, which
  distributes USDC to the temple recipient and fee recipient. Cash is recorded
  off-chain only after the device session is stopped and inventory/counters are
  reconciled; it is not a `DonationVault` payment. Recognized cash fees are
  settled separately through `CashFeeVault`. Central's minter submits stamp
  transactions to `KalashStamp`.
- Central validates and writes application records to Firestore and accesses
  photos in a private Cloud Storage bucket. Public board data and images are
  served through Central's same-origin API; the bucket is not public.
- The configured chain is **Base Sepolia, not Base mainnet**. In local
  development the local Central process serves the web app and API, while
  Firebase, Firestore, Cloud Storage and Base Sepolia remain real services.
