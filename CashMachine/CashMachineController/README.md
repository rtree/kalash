# KALASH CashMachineController

This is the KALASH-owned Windows controller project, targeting .NET 10 with
the distinct product/process identity `KALASH.CashMachineController`. It
contains the local REST API Server process host, ITL adapter and separately
gated local cash diagnostic; build outputs are ignored by Git.

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
Central's independent registered `cashEnabled` flag must also be authorized by
the integrator; heartbeat does not switch it on. Await an actual fresh ready
screen/health record before signed claim and actual ACCEPTING before insertion.

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

Hardware uncertainties remain: actual ACCEPTING/state/event spellings, complete
counter/module shapes, route/fullness semantics and delayed-event timing need
owner-attended verification with the installed firmware. No synthetic fixture
proves real note acceptance, physical capacity, Central persistence or donation
settlement.

If `KALASH_ITL_JWT_KEY` is absent, the controller creates a fresh ephemeral
signing key in memory for the server child; it is not persisted. The test runner
does not start the manufacturer server. No Windows service/autostart setup is
included.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
