# KALASH contributor entry

- Explicitly read this file on first use and resume; do not assume automatic loading.
- First read `docs/SPEC.md`. Resume from `docs/TASKS.md` and relevant SPEC/SDD sections.
- SPEC is input, SDD is current design, TASKS is the only progress source.
- Focus on the current goal. Respect file ownership in TASKS.
- Before dependency acquisition run `node scripts/check-policy.mjs`.
- Use pinned pnpm/Node, a 168-hour release age and disabled install scripts (SPEC 3.3).
- Never use npm, download generators, install hooks or unverified lockfiles.
- Run the policy check before install, build, test, CI and deployment.
- Mandatory API tests must run: zero tests or all skipped is not success.
- Keep secrets, private photos and manufacturer files out of Git and logs.
- Confirm actual receipts/events, database state and UI; never synthesize success.
- Record task-specific blockers and continue independent work in the current goal.
- Reconcile SDD/TASKS about every ten minutes and at milestones; commit and push.
- Only the integrator writes Git and shared SDD/TASKS; stage explicit paths.
- Do not retry unknown payments, mint submissions or cash commands blindly.
- Before handoff record version, evidence, remaining work, human action and next step.
