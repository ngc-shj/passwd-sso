# Plan Review: passkey-enforcement-token-paths
Date: 2026-06-29
Review round: 1

## Changes from Previous Round
Initial review (functionality / security / testing).

## Headline: the plan closes the extension+iOS bypass correctly, but the choke-point set is INCOMPLETE — MCP OAuth is a third unguarded token-mint path (S1, Critical). Must be fixed before implementation.

## Security Findings
- **S1 [Critical, escalate]** — MCP OAuth consent (`/api/mcp/authorize` GET + `/api/mcp/authorize/consent` POST → `createAuthorizationCode`) is a third session-gated token-mint precursor, NOT under `/dashboard` (page-route gate misses it), only `requireRecentSession` step-up (freshness, not passkey). A non-passkey OIDC user post-grace mints MCP tokens (passwords:read/vault scopes — highest value). FIX: gate both MCP authorize entry points with `passkeyEnforcementBlocks`. Update R42 member-set to codebase-derived + CI guard.
- **S3 [Major]** — token-path audit uses logAuditAsync (no dedup); page-route deliberately dedups (PASSKEY_AUDIT_DEDUP_MS) to stop flood. Token routes are retry loops → audit flood. Reuse `recordPasskeyAuditEmit` (extract to shared module).
- **S5 [Minor]** — iOS refusal: use `error=passkey_required` on the FIXED scheme, NOT redirect-to-dashboard (smaller surface, no cookie re-entry). CONTRADICTS F1 (func); security view wins.
- S2 [Minor] classify all session-gated mint routes (admin-gated SA/operator/SCIM = out of scope with reason, not omitted). S4/S6/S7 pass.

## Functionality Findings
- **F1 [Major]** — C3 "mirror existing convention" ill-defined (route has no error-to-scheme precedent). RESOLUTION: per S5, use `error=passkey_required` to fixed scheme. (Func expert preferred web-view redirect; security S5 overrides for surface reduction.)
- F2 [Minor] — coerceErrorCode allowlist is a second gate; add PASSKEY_REQUIRED there.
- F3 [Minor] — pin invariant: token routes use live auth(), never cached session.
- F4 [Minor] — add enabledAt=null immediate-block row to C2/C3 matrices.
- Verified: placement, session fields available, audit reuse, propagation mechanics all sound (modulo S1 completeness).

## Testing Findings
- **T1 [Major]** — MockSession lacks the 4 passkey fields → block branch vacuously uncovered. Extend MockSession + per-test overrides.
- **T3 [Major]** — coerceErrorCode seam untested (component test mocks requestExtensionConnect wholesale). Add direct unit test.
- T2/T4/T5/T6 [Minor] — only isPasskeyGracePeriodExpired moves (dedup helpers stay/shared carefully); enum mock literal update; pin C3 refusal-shape assertion; pin C4 emit cardinality (ONLY PASSKEY_ENFORCEMENT_BLOCKED). T7 mock-alignment enumeration (4 sites).
- Confirmed: all branches unit-testable; R12/RT6 satisfied.

## Cross-cutting consensus (round 1)
- The fix is RIGHT in approach (choke-point enforcement, shared helper) but INCOMPLETE in coverage (MCP). The R42 member-set was hand-anchored to the prompt's two routes — the exact `feedback_triangulate_enumerate_completeness` failure. Re-derive from the codebase primitive (auth() ∩ mint-primitive) and add a CI guard.
- iOS response = error=passkey_required to fixed scheme (S5 > F1).
- Reuse the page-route audit dedup across all sites (S3).

---

# Review round: 2

## Changes from Previous Round
Plan revised per round-1 (added C6 MCP gating, C7 CI guard, shared audit dedup, iOS error method). Round 2 verified the resolutions AND hunted deeper.

## Verdict round 2: round-1 initial-mint findings RESOLVED, but TWO new Critical findings — the fix scope materially expands.

## Security (round 2)
- **S8 [Critical, escalate]** — the REFRESH grant re-mints tokens with NO passkey re-gating, a 4th bypass class. Web session is re-evaluated per navigation; tokens are NOT re-evaluated on refresh. A non-passkey user who connected once (pre-enforcement / during grace) keeps refreshing AFTER the policy turns on: MCP **forever** (no absolute cap), extension 30d, iOS 7d. C6 gates NEW MCP connections but is useless for ALREADY-connected agents. SC2's "already gated upstream" is FALSE for the refresh grant. → C8 added (gate all 3 refresh routes + add MCP absolute cap).
- **S9 [Major]** — C7 guard grep omitted refresh re-minters → would certify S8 as complete. Also `auth()`-trigger excludes cookieless refresh routes. → C7 primitive set extended; trigger on primitive not auth().
- S10/S11 [Minor] — dedup map sizing across 4 paths; grace-window overhang. Noted.
- S1/S3/S5 confirmed RESOLVED (createAuthorizationCode single-caller, no auto-consent; dedup; iOS fixed-scheme).

## Testing (round 2)
- **T8 [Critical]** — passkey fields are at `session.user.*` for auth()-driven routes, not top-level. Helper read the wrong level → block tests vacuous (round-1 T1 reappears deeper). Mock prereq also misdirected (only bridge-code uses MockSession; mobile/mcp use inline literals). → C1 caller-shape + testing mock-nesting fixed; non-vacuity assertion added.
- **T9 [Major]** — `coerceErrorCode` not exported → direct unit test infeasible. → export it (C5).
- T10/T11 [Minor] — dedup-map reset in new tests; mandatory C7 self-test (repo has the `check-permanent-delete-stepup.test.mjs` precedent).

## Functionality (round 2)
- F1-F4 RESOLVED. F5 (enum member), F6 (GET vs POST error shape differ — disambiguate per route), F7 (consent page mints nothing, GET+POST gate sufficient) — all Minor, folded into C5/C6.

## Status after round-2 revision
All round-1 + round-2 findings reflected in the plan (C8 added, C1/C5/C6/C7 revised, testing strategy corrected). Plan NOT yet re-reviewed in a round 3 — implementation deferred to a fresh session per user decision; a round-3 pass is advisable before/at implementation start since C8 materially expanded scope.
