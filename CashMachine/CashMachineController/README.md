# KALASH CashMachineController

This is the KALASH-owned Windows controller project, targeting .NET 10 with
the distinct product/process identity `KALASH.CashMachineController`. It
currently contains the local REST API Server process host and a read-only ITL
API client; build outputs are ignored by Git.

The controller will manage only the manufacturer REST API Server child process
that it starts from an explicitly configured local installation. It must not
discover or stop processes by a shared executable name or port. The server must
remain bound to loopback and must not be exposed as a network service.

Build and run the fake-child/configuration tests with:

```powershell
node scripts\check-policy.mjs
dotnet run --project CashMachine\CashMachineController.Tests\KALASH.CashMachineController.Tests.csproj
```

The test runner does not start the manufacturer server. The explicit `run`
command requires a local `RESTAPIServer` directory, an absolute
`KALASH_ITL_DOTNET` path, and protected `KALASH_ITL_JWT_KEY`; it reports only
process liveness, not API authentication or device readiness. No cash-device
commands are implemented. Verify real server startup and ITL/device behavior
only in the later M3-device task with the authorized machine. Windows service
registration is a separate, later approval and is not part of this scaffold.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
