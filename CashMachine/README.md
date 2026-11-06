# KALASH Cash Machine

This directory is reserved for KALASH-owned cash-machine integration code and
its local vendor-driver boundary. It is separate from the web application and
from unrelated projects on the development machine.

- [CashMachineController](./CashMachineController/README.md) describes the
  planned KALASH-owned Windows controller.
- [RESTAPIServer](./RESTAPIServer/README.md) documents the locally installed,
  manufacturer-provided REST API server used as its driver.

The manufacturer server, its libraries, manuals, credentials, and runtime
configuration are not KALASH source and must not be copied into Git or a KALASH
release. The REST API Server directory is ignored except for its README.

The current milestone is M5a: Cash remains disabled. No cash commands, physical
device operations, or Windows service registration are part of this preparation.
See [TASKS](../docs/TASKS.md), [SPEC section 8](../docs/SPEC.md), and
[SDD section 8](../docs/SDD.md) for the tracked scope and device contract.
