# Coding Deviation Log: team-config-stepup-bearer-scope

### D1 — JSDoc block-comment parse fix (C4, side-fix)
- **File**: `src/lib/proxy/cors-gate.ts`
- The S1-constraint doc comment originally wrote `teams/*/passwords` — the `*/` prematurely closed the JSDoc block comment (parse error). Changed to `teams/<teamId>/passwords`. Side-fix discovered during the sub-agent's own test run; documentation-only, no behavior change.

## Phase 3 deviations

### D2 — F3 in-code SC1 TODO markers skipped (review F3, Minor)
- **Anti-Deferral check**: out of scope (cosmetic — deferral already tracked)
- **Justification**: review F3 proposed adding `TODO(team-config-stepup)` comments to the SC1-deferred routes (rotate-key POST, team DELETE, member DELETE) to signal the deliberate step-up deferral in-code. Skipped because the deferral is the system-of-record in the plan's SC1 + this deviation log; adding comments to 3 route files this PR otherwise does not touch expands the diff with noise and zero behavior change (YAGNI). The functionality expert marked it optional/cosmetic.
- **Orchestrator sign-off**: deferral documented in SC1; no in-code marker needed.
