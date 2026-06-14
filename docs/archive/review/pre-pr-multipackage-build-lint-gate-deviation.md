# Coding Deviation Log: pre-pr-multipackage-build-lint-gate

No deviations from the plan. All five contracts (C1–C5) implemented as specified.

## Verification notes (not deviations)
- **C2 negative-test nuance**: a *side-effect* extensionless import (`import "./index"`) does NOT trigger TS2835, but a *named* extensionless import (`import { x } from "./index"`) does (tsc EXIT=2). The actual #651 regression class is the named/`from`-clause form (`from "./time"`), so the gate (`cd cli && npm run build`) catches it. The initial harness used the side-effect form by mistake; re-tested with the named form → TS2835 confirmed.
- Implemented files: `eslint.config.mjs` (C1), `scripts/refactor-phase-verify.mjs` (C5), `scripts/pre-pr.sh` (C2/C3/C4). All in working tree (uncommitted — commit pending user instruction).
