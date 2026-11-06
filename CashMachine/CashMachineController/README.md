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

The `validate` command checks the local package and child environment overrides
without launching the server. The `inspect` command is the Stage 1 check: it
requires protected `KALASH_ITL_USERNAME` and `KALASH_ITL_PASSWORD`, starts its
own server child, verifies loopback binding and Host filtering, authenticates,
reads only USB/device lists, then stops the child. It never opens a device,
polls events, or issues a cash command. The long-running `run` command requires
a local `RESTAPIServer` directory and an absolute `KALASH_ITL_DOTNET` path; it
reports process liveness only.

If `KALASH_ITL_JWT_KEY` is absent, the controller creates a fresh ephemeral
signing key in memory for the server child; it is not persisted. The test runner
does not start the manufacturer server. No cash-device commands are implemented.
The Stage 2 `OpenConnection` initialization is a separate, explicit gate;
Windows service registration is also separate and not part of this scaffold.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
