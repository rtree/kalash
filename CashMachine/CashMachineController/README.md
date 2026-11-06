# KALASH CashMachineController

This is the reserved location for the KALASH-owned Windows controller project.
The controller is planned for .NET 10 and must have a product/process identity
distinct from unrelated software on the same PC. No controller executable has
been created here yet.

The controller will manage only the manufacturer REST API Server child process
that it starts from an explicitly configured local installation. It must not
discover or stop processes by a shared executable name or port. The server must
remain bound to loopback and must not be exposed as a network service.

Initial preparation and tests must not issue cash-device commands. Use a
controlled fake child process for lifecycle tests; verify real server startup
and ITL/device behavior only in the later M3-device task with the authorized
machine. Windows service registration is a separate, later approval and is not
part of this scaffold.

Keep credentials and machine-specific paths outside Git. Never log credentials
or copy manufacturer binaries, manuals, or configuration into this project.
