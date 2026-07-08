# Plan Review: step-up-client-policy-card
Date: 2026-07-08
Review rounds: 3 (converged)

## Summary
Triangulate plan review across functionality / security / testing, 3 rounds. The
plan evolved substantially under review — the headline outcome is that the initial
"fix the one policy card" framing was wrong on two axes, both caught pre-implementation:

1. **Member-set was under-enumerated (F1, Critical, Round 1)** — set membership is
   per (route, method), not per component; several "already handled" components
   (mcp-client-card, service-account-card, even the reference api-key-manager) wire
   step-up on only SOME of their gated mutations. Re-derived the full ~24-member set
   from `requireRecentCurrentAuthMethod` callers.
2. **The CI guard could not be a grep-inference guard (F7, Major, Round 2)** — three
   caller path-spellings (raw template literals, prop-indirection, apiPath helpers)
   defeat token grep, so an inference guard goes GREEN while blind to real members.
   Pivoted to a marker-verified guard.
3. **The marker guard's handling-check was file-scoped (C1-R3-2, Critical, Round 3)** —
   whole-file grep false-PASSes the live mcp-client-card F1 case. Fixed with an
   adjacency-window mechanism + a two-handlers-one-file self-test fixture.

## Round 1 findings (initial plan)
- **F1 [Critical]** member-set per-component not per-(route,method); partial gaps in
  mcp-client-card, service-account-card, team-scim-token-manager, access-request-card,
  api-key-manager. → RESOLVED: re-derived per-method; C2 lists all.
- **F2 [Major]** param-conditional gating (`?permanent=true`). → RESOLVED (marker on the
  in-branch call; ungated soft-delete simply unmarked).
- **F3/F4 [Minor]** base-webhook owns fetchApi; adapter typed-error feasible, single
  consumer. → RESOLVED, C5/C4 locked.
- **F5 [Major]** guard route→API_PATH→caller mapping hand-wavy. → superseded by F7 pivot.
- **S1-S3 [Confirm]** fix is UX-completeness, fail-CLOSED, reauth is genuine. No finding.
- **S4 [Minor]** allowlist should assert custom-marker presence. → RESOLVED in C1.
- **T1 [Major]** guard needs checked-in `.test.mjs`. → RESOLVED.
- **T2 [Major]** wire into pre-pr.sh run_step + no `@prisma/client`. → RESOLVED.
- **T3 [Major]** shared abstractions need per-consumer tests. → RESOLVED.
- **T4/T6 [Minor]** useLocale mock; trash.spec re-run + stale-window E2E. → RESOLVED.

## Round 2 findings (updated plan)
- **F6 [Minor]** "guard reproduces this set exactly / any delta is a bug" framing wrong —
  the ~15 already-handled gated routes correctly don't appear in S\C. → RESOLVED (framing
  corrected; already-handled members also get markers).
- **F7 [Major]** grep-inference guard cannot resolve raw-literal / prop-indirection /
  helper callers → blind spot on named members (team-policy-settings, base-webhook). →
  RESOLVED: pivot to two-sided `@stepup id:X` marker scheme (no path resolution).
- **T7 [Major]** test-count not reconciled with per-method fix granularity; base-webhook
  needs both methods per consumer. → RESOLVED (explicit count).
- **T8 [Major]** self-test fixtures don't exercise the hardest resolution logic. →
  superseded by marker pivot; fixtures expanded.
- **T9 [Minor]** param-conditional allowlist untested. → RESOLVED (marker sits on
  in-branch call; no allowlist needed).

## Round 3 findings (marker-guard design)
- **C1-R3-1 [Minor]** marker scheme confirmed to eliminate F7 path-resolution. Sound.
- **C1-R3-2 [Critical]** "enclosing handler function body" not bash-achievable; file-scoped
  grep false-PASSes live mcp-client-card (SESSION_STEP_UP_REQUIRED once, 3 gated handlers).
  → RESOLVED: adjacency-window (`awk` N-lines-below-marker), not file grep.
- **C1-R3-3 [Major]** recommend adjacency (bash, no parser) over ts-morph; ts-morph as
  escalation. → ADOPTED (adjacency default).
- **C1-R3-4 [Major]** server-marker completeness must be line-bound (H/H-1) per call, not
  a file-level count. → RESOLVED.
- **C1-R3-5 [Major]** add fixture (vii): two marked handlers in one file, one branched one
  not → FAIL. Only fixture that distinguishes adjacency- from file-scoping. → RESOLVED.

## Convergence
All contracts locked at end of Round 3. C1 is implementable as pure bash+grep+awk+filesystem
(no `@prisma/client`), adjacency-scoped, with a 7-fixture self-test including the F1
regression lock. Member-set is code-derived per (route, method); the marker coverage gate
(S\C) is the R42 ①b convergence artifact for a class that expanded 8→16→24+.

## Recurring Issue Check (key rules for this plan)
- R42 (member-set derivation): CENTRAL — derived from `requireRecentCurrentAuthMethod`
  primitive per (route, method); guard mechanizes the invariant. ✓
- RT7 shape b (authored-but-unproven gate): addressed — 7-fixture self-test + mutation demo
  + pre-pr.sh wiring. ✓
- project_static_check_ci_no_prisma_generate: guard forbidden from importing @prisma/client. ✓
- project_ci_gates_beyond_pre_pr: E2E called out as outside default gate. ✓
