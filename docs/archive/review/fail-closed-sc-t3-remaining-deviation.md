# Coding Deviation Log: fail-closed-sc-t3-remaining

## Phase 2 entries (2026-07-20)

- **Process deviation — Step 2-2 delegation skipped**: contracts C1-C4 were
  implemented directly by the orchestrator instead of Sonnet sub-agent
  batches. Reason: contracts were file:line-precise and small (4 batches,
  9 files, all traps already enumerated in the plan); delegation overhead
  plus R21 re-verification cost exceeded the benefit. Phase 3 triangulated
  review still applies unchanged. Ollama deviation scan of the src diff:
  "No new deviations" (code matches plan contracts).
- **check-hardcoded-reuse Major ×2 — adjudicated false positive (R2
  meaning-equality clause)**: the flagged literal
  `"@/__tests__/helpers/fail-closed"` in the two v1 test files is an ES
  import specifier; the matching constant `HELPER_MODULE` lives in
  `scripts/checks/classify-fail-closed-test.mjs` (a Node gate script test
  files cannot import). All 18 previously migrated helper-mode test files
  use the same literal specifier. No action.
- **check-markdown-autolinks residual 2 hits on plan line 411 — hook false
  positive**: the line contains two inline code spans (`` `709b6d9a8` ``,
  `` `#682` ``) after the fix; the hook's code-span stripper mishandles
  multiple spans on one line. Content verified backticked.
- **C2 test literal "45" instead of "30"**: response.test.ts's
  extra-headers passthrough case uses `Retry-After: "45"` so the test does
  not collide with the plan's forbidden pattern (`"Retry-After": "30"` in
  src/lib/scim/) and does not accidentally couple to the production
  default. Contract-consistent micro-decision.
