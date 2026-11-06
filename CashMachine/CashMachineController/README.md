# KALASH CashMachineController

This is the KALASH-owned Windows controller project, targeting .NET 10 with
the distinct product/process identity `KALASH.CashMachineController`. It
currently contains the local REST API Server process host and a gated ITL
diagnostic client; build outputs are ignored by Git.

The controller will manage only the manufacturer REST API Server child process
that it starts from an explicitly configured local installation. It must not
discover or stop processes by a shared executable name or port. The server must
remain bound to loopback and must not be exposed as a network service.

Build and run the fake-child/configuration tests with:

```powershell
node scripts\check-policy.mjs
dotnet run --project CashMachine\CashMachineController.Tests\KALASH.CashMachineController.Tests.csproj
```

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
lists, then stops its child. `ItlControllerClient` has no credential-update,
acceptor-enable, escrow accept/return, or payout API. The long-running `run`
command only reports process liveness.

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

If `KALASH_ITL_JWT_KEY` is absent, the controller creates a fresh ephemeral
signing key in memory for the server child; it is not persisted. The test runner
does not start the manufacturer server. The only device-changing API exposed
is the explicitly gated OpenConnection/DisconnectDevice initialization pair;
cash acceptance and payout are not implemented. No Windows service/autostart
setup is included.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
