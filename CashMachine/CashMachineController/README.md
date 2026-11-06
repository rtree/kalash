# KALASH CashMachineController

This is the KALASH-owned Windows controller project, targeting .NET 10 with
the distinct product/process identity `KALASH.CashMachineController`. It
contains the local REST API Server process host, ITL adapter and separately
gated local cash diagnostic; build outputs are ignored by Git.

## Product payout safety gate

The resident `run` host wires payout through the existing serialized product
owner and `ItlProductCashDevice`, without another consuming reader. The separate
`KALASH_PRODUCT_PAYOUT_ENABLE=OWNER_ATTENDED_PRODUCT_PAYOUT` gate is off by
default, requires the existing product-cash gate, and must not be enabled before
explicit real-payout approval. `Run-Local.ps1` uses these process environment
settings; neither build nor tests starts hardware.

The adapter sends one authenticated `DispenseValue` with the full approved
recycler amount, excluding cashbox. Durable dispatching/unknown never retries.
Completion needs DISPENSED, transaction COMPLETED, a later owned idle/disabled
poll, explicit empty escrow, and matching levels/counters. The owner's explicit
decision removes the separate bezel-empty preflight check: no operator
attestation or fabricated bezel-empty observation is sent. Device handling is
trusted, while actual NOTE_HELD_IN_BEZEL/NOTE_IN_BEZEL_HOLD events remain waiting
states, not completion. Missing bezel readback alone does not block payout.

Unknown outcomes preserve a monotone, counter-verified partial end-state when
explicit physical readiness is available. Fresh operator authorization from
`GET /api/controller/:atmId/payout-reconciliation-command` binds command/payout,
new approval UUID, baseline/current inventories and expiry. Exact Central ACK
and unchanged physical readback retire only payout-related locks; the original
command is never repeated. Central retains the already-settled remaining value
and issues a new payout/command/approval for that remainder.

The prior health 503 cannot be attributed to later host disconnect/REST-stop:
`RunAsync` returns only after its health/report calls finish, before those host
operations. Health readback performs USB/list/complete-device/levels/counters
GETs; old sanitized logs omit which one failed. New diagnostics include only
the safe operation name and status, never bodies or credentials. The precise
upstream 503 cause remains unverified; readiness failures still fail closed.

The controller will manage only the manufacturer REST API Server child process
that it starts from an explicitly configured local installation. It must not
discover or stop processes by a shared executable name or port. The server must
remain bound to loopback and must not be exposed as a network service.

Build and run the fake-child/configuration tests with:

```powershell
node scripts\check-policy.mjs
dotnet run --project CashMachine\CashMachineController.Tests\KALASH.CashMachineController.Tests.csproj --no-restore -- --product
```

The focused product tests use explicit synthetic Central/ITL HTTP transports,
not hardware evidence. Omit `-- --product` to include the existing controller
configuration, command replay and diagnostic regression fixtures.
To export the actual C#-serialized HTTP fixture for cross-language validation:

```powershell
node scripts\check-policy.mjs
dotnet run --project CashMachine\CashMachineController.Tests\KALASH.CashMachineController.Tests.csproj --no-restore -- --export-cash-wire CashMachine\CashMachineController.Tests\fixtures\product-cash-wire.synthetic.json
```

The output labels itself synthetic and contains ordered `commandReports`,
`cashSessionResponses` and `events`. Each `events` element can be passed directly
to Central's `validateCashEvent`; the fixture includes a reconciled ₹100
Done/STORED race, not live cash evidence.

For the first real, non-destructive Stage 1 check, run
`.\CashMachine\CashMachineController\Inspect-Local.ps1`. It reads the vendor's
v2 Authenticate sample from the local Fresh package in memory and first checks
that the dedicated server binary/configuration and `users.json` match that
package. It does not alter or persist credentials. Stage 1 starts only its own
REST API child, verifies loopback/Host filtering and authentication, reads USB
and connected-device lists, and then stops that child. It does not open the
validator or consume events.

The `validate` command checks local package configuration without launching the
server. `inspect` verifies loopback binding and Host filtering, authenticates
with the unchanged vendor default account, reads only USB and connected-device
lists, then stops its child.

`.\CashMachine\CashMachineController\Initialize-Local.ps1` is the separately
scoped Stage 2 operation. It sends exactly one `OpenConnection` using the
detected single COM port, Spectral Payout Route=1, and both acceptor and
automatic escrow acceptance disabled. A single `GetDeviceStatus` poller checks
the route-complete events; identity, escrow state, levels, counters and
currency assignment are then read. After verifying `DISABLED` and an empty
escrow, it sends one `DisconnectDevice`, confirms the device list is empty, and
stops its own server child. It never accepts or dispenses a note. If device
state is unresolved, it does not retry `OpenConnection` or stop the server
child; follow the reported PID and reconcile the state first.

`Reconcile-Local.ps1 -ServerPid <pid>` attaches only to the explicitly supplied
PID after checking that it is the dedicated .NET server and sole owner of port
5000. It performs authentication and read-only inventory/state calls plus one
consuming status poll; it never sends a device-changing command.
`Complete-Initialization-Local.ps1 -ServerPid <pid>` may be used only after
that reconciliation. It rechecks DISABLED, empty escrow, identity, levels and
counters, sends one DisconnectDevice, confirms the device list is empty, then
stops that exact server PID. It refuses to stop if any check is unresolved.

`diagnose-cash` is separate from product mode. It requires interactive
owner/operator confirmation, enables only the ₹100 denomination, accepts at
most one ₹100 INR note, waits for matching ESCROW/STORED events, requires Done,
then verifies levels and stored/stacked counters. Its durable journal is local
diagnostic evidence only; it never creates a donation, mint or Central record.
An unresolved diagnostic blocks another diagnostic until reconciled.
The device's `ACCEPTING` state representation is fail-closed and still requires
live verification before a note is inserted.

The long-running `run` worker loads the registered ATM record from
`%LOCALAPPDATA%\KALASH\secrets\atm-01.json`; `KALASH_CENTRAL_URL` and
`KALASH_ATM_ID` may explicitly override the non-secret connection fields.
The bearer token is file-only and is never logged. A single ITL status poller
durably records state changes and events before handing them to the worker.
Product cash is **off by default**. Only the exact environment value
`KALASH_PRODUCT_CASH_ENABLE=OWNER_ATTENDED_PRODUCT_CASH` selects the product
worker. Unset/empty/`false` preserves no-cash mode; other values fail configuration.
This is an operator attendance/physical authorization gate, not a substitute for
Central's signed-consent command, matching visit/session, online permission,
deadline, verified INR routing and available capacity. Do not set it before
owner-attended hardware validation. No product payout path is implemented.

### Owner-attended single ₹100 product run

The operator alone runs this, from the repository root, after attendance and
physical authorization. This preparation does not itself run either command:

```powershell
$env:KALASH_PRODUCT_CASH_ENABLE = 'OWNER_ATTENDED_PRODUCT_CASH'
.\CashMachine\CashMachineController\Run-Local.ps1 -OneHundred
```

`Run-Local.ps1` resolves the same repository-local REST server, Fresh package and
explicit `dotnet.exe` as the existing initialization scripts. It runs the policy
check and uses the protected registered ATM file without printing credentials.
It never sets the physical gate. Without the gate, its default run is no-cash;
`-OneHundred` refuses to start without the existing gate. Remove unintended
`KALASH_CENTRAL_URL`/`KALASH_ATM_ID` overrides before launching if the registered
origin/ATM should be used. Do not start the vendor server separately.

The `run --one-100` restriction opens with only ₹100 uninhibited, verifies that
exact readback, and durably restricts the session to one accepted ₹100 note,
including an in-flight note. Other denominations remain inhibited. All original
₹400/session and ₹1,000/10-note inventory ceilings still apply. The first matching
STORED automatically stops acceptance with `capacity`; Done can race safely with
that close, but must not be fabricated if capacity has already closed it. Do not
open a second reception in this operator run. The bounded worker cannot start
another reception after the first intake has begun. This restriction is not a new
authorization gate or a payout permission.

Every five seconds, the product owner posts authenticated `/health` from actual
USB/connected-device, identity, open/started, route, inventory and counter reads.
Its durable increasing sequence survives restart. Readiness also requires a
fresh observation from the existing event reader, no reconciliation lock, and
matching one-note inhibits when selected. The health path never starts another
consuming poller, and idle status observation continues on the same owner.
Readback/report failure blocks acceptance; shutdown posts unavailable.
After synchronous command reports, outbox POSTs or slow readbacks, a due
heartbeat refreshes stale status through that **same** execution owner before
reporting poller readiness. It also refreshes when a new readback shows an
IDLE/ACCEPTING transition after an otherwise fresh prior poll. The two-second
freshness limit uses the actual status observation time and is not extended.
Current session permission is refreshed before consuming events when needed.
Previously verified health is not artificially cleared during that poll;
actual invalid readbacks revoke it. An ESCROW consumed there is durably
decided/dispatched before waiting on the health POST. A false health report logs
only its readiness booleans and `lastPollAgeMs`; real readback/transport
failures still stop acceptance.

The owned reader applies every event in a batch in order. A bound readiness
observation requires the last device-status event and the summary to agree on
IDLE, but permits other known events in the same batch. Unknown events, a
contradictory status summary, or an uncommanded DISABLED during reception
require reconciliation even if a later event says IDLE. The raw batch remains
in the journal. Only `GetCompleteCashDevice` code `4` is used as the known
DISABLED mapping outside the separately verified IDLE readiness check (code
`5`). Active `IDLE`/`ACCEPTING` health follows the fresh owned-reader string
state; unobserved numeric values are not guessed.
Central's independent registered `cashEnabled` flag must also be authorized by
the integrator; heartbeat does not switch it on. Await an actual fresh ready
screen/health record before signed claim and a Central-confirmed, causally bound
device-ready observation before insertion. The observed waiting state can be
actual `IDLE`; it is never renamed `ACCEPTING`.
All Central requests include the configured canonical HTTPS `Origin`
(scheme/authority, no trailing slash) as well as the Controller Bearer credential.
Before starting any REST child, product `run` durably advances the same health
sequence and posts a truthful all-unavailable health report. A rejected POST
(including HTTP 403), malformed receipt or transport error aborts startup before
OpenConnection. Runtime failure logs include HTTP status codes when available,
never response bodies, credentials or arbitrary exception messages.

After the one note, use Done if the intake is still accepting; wait for its
actual Central close/confirmation and retained journal/outbox acknowledgement.
`-OneHundred` then exits naturally: only after that first intake is cleanly
closed, every outbox event has its exact durable ACK, and the same reader plus
fresh readbacks reverify DISABLED, empty escrow, and unchanged final
inventory/counters. The host then performs its existing safe disconnect and
owned-child shutdown. No Ctrl+C or external process termination is needed on
this successful bounded path. Regular `run` stays resident.

For an operator cancellation, press **Ctrl+C once** in the controller console.
It disables once if necessary,
continues that same reader for pending cash, reports unavailable, and disconnects
and stops only its own child after verified safe state. Unknown/reconciliation
states never count as bounded completion or trigger automatic child killing.
An unresolved shutdown
prints the retained child PID: do not kill/relaunch or clear journals; reconcile
that same operation. After a clean exit remove the process gate:

```powershell
Remove-Item Env:\KALASH_PRODUCT_CASH_ENABLE -ErrorAction SilentlyContinue
```

No Payout/Dispense command belongs in this procedure. The note remains in the
machine for the separately authorized later fee/admin payout.

### Startup-only parser reconciliation

The observed SDK initialization response is `DeviceStatusResponse`, with ordered
CONNECTING, CONNECTED, STARTING, STARTED, DISABLED states, then six successful
route results. These known states are accepted; unknown states still fail closed.

For the specific older `unknown_device_event` startup misclassification only,
first stop the Controller owner without stopping its retained vendor child.
The operator may then run this explicit helper against that same verified PID:

```powershell
.\CashMachine\CashMachineController\Reconcile-ProductInitialization-Local.ps1 -ServerPid <verified-existing-pid>
```

This does not launch a server or restart product mode. Controller mutex and
journal ownership must be free. Eligibility requires the exact sole startup
lock, one-₹100 profile, no intake, outbox, completed sessions or local command
history, no interrupted poll/connection/recovery marker, and the retained one
DISABLED raw snapshot containing exactly the five observed state transitions
and six successful route results. It cannot clear a general cash lock.

Before any consuming read, it archives the original locked state and exact raw
journal bytes/hash under `initialization-recovery-evidence`. With one reader it
requires current DISABLED/no new events before and after fresh identity,
open/started/error/escrow, USB/binding, all six INR levels/routes/inhibits and all
four counters. Only ₹100 may be uninhibited; empty escrow is mandatory.
It persists a disconnect-dispatch marker, sends Disconnect once and verifies an
empty connected-device list. Only then does it remove this one startup reason,
retain the original reason/readbacks/archive reference in `state.json`, and
mark the manual connection unavailable.

After that successful verification the wrapper rechecks PID identity and port
ownership, stops only that disconnected child, and keeps all evidence. Any
unknown result retains the lock/phase and forbids blindly rerunning the helper.
It never sends OpenConnection, EnableAcceptor, Accept, Return or Payout. The
general `Complete-Initialization-Local.ps1` assumes a different inhibit profile
and is not a substitute for this exact startup-only reconciliation.
Another product launch requires fresh parent/operator approval.

### Actual IDLE readiness evidence

The repository-local **Spectral Payout REST API Manual, Document Revision v.14**
(`Spectral Payout REST API Manual-v14.pdf`) is the reference:
**GetCompleteCashDevice V2 (Spectral Payout), pp.81–91**;
**GetDeviceStatus V2 (Spectral Payout), pp.95–99**, particularly the ordered
response example on p.99; and **EnableAcceptor V2 (Spectral Payout), p.133**.
The response example distinguishes waiting IDLE from the subsequent
ACCEPTING/ESCROW/storage sequence. The complete-device schema has no explicit
acceptor-enabled field. Manufacturer material is not copied into source.

An arbitrary IDLE, numeric state alone, or successful HTTP response cannot
authorize intake. The sole owner must first observe DISABLED and verify the
signed session, empty escrow, manual-escrow connection, six payout routes,
inhibits, identity, inventory and four counters. It persists the disabled raw
sequence and Enable dispatch timestamp **before** its one Enable. Following
the acknowledgement, it requires a new persisted DeviceStatusResponse IDLE,
a fresh matching full readback (numeric state 5), unchanged baseline inventory,
and still-current signed permission. The immutable
`readinessEvidence.version=itl-idle-after-enable-v1` includes actual timestamps,
command/session/device binding, raw sequences and both strict inventories.
The command journal retains it for identical observed/reported retries.
Central receives the actual `deviceState:"IDLE"` and anchors its deadline to
that observation; command acceptance precedes the intake baseline event and
any physical Accept. Actual ACCEPTING observations remain supported.
An active IDLE heartbeat requires that same durable enabled intake; an idle
unbound device is available only when DISABLED. Closing and reconciliation
remain unavailable and require actual DISABLED/empty before safe shutdown.

Export the actual synthetic HTTP observation, without credentials or hardware:

```powershell
node scripts\check-policy.mjs
dotnet run --project CashMachine\CashMachineController.Tests\KALASH.CashMachineController.Tests.csproj --no-restore -- --export-idle-readiness-wire .local\cash-idle-readiness-wire.json
```

### Explicit zero-note failed-start recovery

This **separate** helper applies only to the closed one-₹100 start that retained
exactly `ready_not_observed` and `start_command_not_observed`, zero notes, no
Ready/deadline, exact outbox ACKs, original terminal-unknown command reason
`acceptance_state_not_observed`, and unchanged baseline/final inventory.
It rejects every other lock, interrupted poll/connection, cash event, changed
raw history, unresolved command, or earlier incomplete recovery.

Only the integrator/operator may execute this procedure, after stopping the
Controller owner while preserving its disabled child, confirming no note was
inserted, keeping Central cashEnabled=false, and preparing Central's matching
operator reconciliation. Do not start another owner or diagnostic poller.

```powershell
.\CashMachine\CashMachineController\Reconcile-ProductFailedStart-Local.ps1 -ServerPid <verified-existing-pid> -CashSessionId <failed-session-uuid> -ConfirmNoNotes
```

The wrapper verifies the retained server PID/DLL/port and resolves the existing
registered configuration without printing secrets. The Controller mutex and
journal ownership must be free. Before consuming status, the helper writes
exact original `state.json`, `raw.jsonl` and `command.json` bytes to a new,
write-once directory under
`%LOCALAPPDATA%\KALASH\cash-product\<atmId>\failed-start-recovery-evidence`.
It verifies retained initialization-only history followed by one actual IDLE
and DISABLED transition, then brackets fresh identity/USB/binding/one-100
routes/empty escrow/six levels/four counters with its sole DISABLED/no-event
reader. Current inventory and every counter must equal baseline and final.

It exports the agreed `failed-cash-start-zero-v1` **proof.json**, SHA256-bound
to all three original archives, plus **readback.json**. It persists the
disconnect marker, sends Disconnect once and requires the connected list empty.
Only then does it clear these two local reasons, retain the reconciliation
receipt, and mark the connection unavailable. The old command stays terminal
unknown and non-replayable; completed session, stream, sequence and cash history
are not reset. Restart recognizes only this exact archived reconciled command.
The wrapper stops only the verified disconnected child; it never restarts it.

Immediately use the printed archive directory for Central's separate operator
dry-run/apply. The proof must remain fresh (120 seconds); do not change its
timestamp or rerun physical recovery blindly:

```powershell
$evidence = '<printed-evidence-directory>'
node scripts\reconcile-failed-cash-start.mjs --proof "$evidence\proof.json" --state-archive "$evidence\state.json" --raw-archive "$evidence\raw.jsonl" --command-archive "$evidence\command.json"
# Integrator only, after validating the dry-run:
node scripts\reconcile-failed-cash-start.mjs --proof "$evidence\proof.json" --state-archive "$evidence\state.json" --raw-archive "$evidence\raw.jsonl" --command-archive "$evidence\command.json" --apply
```

Central remains locked until that explicit verified operation and keeps cash
disabled afterward. Recovery sends no OpenConnection, Enable, Accept, Return
or Payout. Any unknown result preserves the phase/locks/evidence and child for
manual reconciliation rather than an automatic retry. A subsequent one-note
launch requires fresh operator approval and a **new** signed reception.

When explicitly enabled, `run` opens at most one device with automatic escrow
acceptance and the acceptor disabled, or attaches only its journal-bound device.
OpenConnection dispatch is durable and an unknown result is not retried.
The same execution owner verifies six successful route results and DISABLED,
per-denomination recyclable payout routing, exact device identity and all four
counters. The existing command processor owns enable-command replay protection.
There is no parallel status poller or event drain in product mode.

Product state is stored under
`%LOCALAPPDATA%\KALASH\cash-product\<atmId>\state.json`; `raw.jsonl` is the
single reader's durable raw journal. An exclusive file handle protects the state.
Stable stream/sequence/event IDs survive restart and remain ordered across cash
sessions. Escrow identity, reserved limits, note decision, dispatch marker and
outbox event are flushed **before** Accept/Return. HTTP success is not storage.
Only matching pending STORED can credit INR payout storage; denomination alone
is not a note key. Limits include in-flight notes: ₹400 per session and the
₹1,000/10-note total-inventory demo ceiling. Unsupported/ambiguous events,
STACKED, missing readback fields and faults latch reconciliation.

An exact `{accepted:true,streamId,sequence}` receipt retires only the durable
outbox head. Lost receipts replay unchanged events, never physical commands.
An interrupted consuming poll is marked before the request: the raw-consumption
versus state-commit crash gap locks reconciliation, even if inventory appears
consistent. Restarting an active intake never automatically resumes acceptance.
Do not delete/edit journals or clear locks to recover cash.

Done/deadline/offline/capacity stops new acceptance and issues Disable once,
but continues the **same** reader for in-flight storage/return. Close requires
observed DISABLED and final escrow, all six payout/cashbox levels, and explicit
stored/stacked/dispensed/transferredToStack counters. Reasons are queued before
intake_closed. A timeout alone cannot manufacture a successful close. Unknown
shutdown leaves the owned REST child for reconciliation instead of killing it.

Hardware uncertainties remain: actual ESCROW/STORED event details, runtime
counter changes, route/fullness semantics and delayed-event timing need
owner-attended verification with the installed firmware. No synthetic fixture
proves real note acceptance, physical capacity, Central persistence or donation
settlement.

If `KALASH_ITL_JWT_KEY` is absent, the controller creates a fresh ephemeral
signing key in memory for the server child; it is not persisted. The test runner
does not start the manufacturer server. No Windows service/autostart setup is
included.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
