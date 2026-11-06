# Manufacturer REST API Server

This directory contains a local copy of the manufacturer-provided CashDevice
REST API Server from ITL SDK package 3.2.9 / CashDevice REST API 2.0.0
(`dotNET_8.0`). The server is a non-redistributable third-party driver
dependency; it is not authored or owned by KALASH. Only this README is tracked
here. All server binaries, DLLs, manuals, user configuration, and credentials
placed in this directory are ignored by Git.

The local copy was hash-verified against the package source. It excludes the
vendor's `REST API Logs` directory; do not copy those logs because they can
contain credentials or tokens.

The current design references ITL SDK package 3.2.9 and CashDevice REST API
2.0.0 using the vendor's .NET 8.0 server package. The reviewed package targets
.NET 8.0 and has `serverconfig.json` set to `localhost:5000`.

The package's `appsettings.json` currently has wildcard `AllowedHosts` and an
embedded signing setting. Do not launch it unmodified. The Controller must
override the host allowlist and supply `Jwt__Key` from protected local
configuration through the child process environment; do not expose or copy the
setting, and do not edit the vendor distribution.

The local Controller requires `KALASH_ITL_REST_SERVER_DIR` to name this
dedicated directory and `KALASH_ITL_DOTNET` to be an absolute `dotnet.exe` path;
it does not search `PATH` for a runtime. `inspect` also requires the API
username and password from protected local configuration. If
`KALASH_ITL_JWT_KEY` is absent, the Controller creates a fresh ephemeral key
in memory and passes it only to the server child. Never put credentials or
signing values in source, command-line arguments, or logs. The child inherits
only a small platform environment allowlist plus its server overrides.

The provided Manual v14 extract (p.182) identifies `Route: 1` as RECYCLER for
Spectral Payout. The SDK v2 Postman `Route: 3` example is for NV4000, and
`acceptRoute: 7` is a readback value, not a request value. Do not generalize
these mappings to other firmware or datasets; verify the target device's
readback before enabling cash operations.

The KALASH CashMachineController can launch and supervise its own server child
process from this local installation. The package configuration has been
validated without starting the server; actual launch, API authentication, and
device readiness remain unverified. Keep the REST endpoint on loopback; never
expose it to the LAN, package it with KALASH, or copy it to a release. Store
machine-specific settings and credentials outside Git. Do not start or stop a
server that the controller did not create.
