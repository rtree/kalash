# Manufacturer REST API Server

This directory is reserved for local installation of the manufacturer-provided
CashDevice REST API Server. The server is a non-redistributable third-party
driver dependency; it is not authored or owned by KALASH. Only this README is
tracked here. All server binaries, DLLs, manuals, user configuration, and
credentials placed in this directory are ignored by Git.

The current design references ITL SDK package 3.2.9 and CashDevice REST API
2.0.0 using the vendor's .NET 8.0 server package. Confirm the installed
distribution and API contract against the authorized manufacturer materials
before implementation or operation.

The planned CashMachineController will launch and supervise its own server
child process from a local installation. Keep the REST endpoint on loopback;
never expose it to the LAN, package it with KALASH, or copy it to a release.
Store machine-specific settings and credentials outside Git. Do not start or
stop a server that the controller did not create.
