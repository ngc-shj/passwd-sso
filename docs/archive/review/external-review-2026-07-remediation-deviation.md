# Coding Deviation Log: external-review-2026-07-remediation

## D1 — C7 SQL shape: batch-bounded instead of unbounded UPDATE
Plan quoted a bare `UPDATE ... WHERE status='PENDING' AND expires_at < now()`. Implemented as `(id) IN (SELECT id ... LIMIT $1)` batch-bounded UPDATE — required by the worker-policy-manifest sweepBounds gate (assertion 12), which rejects non-LIMIT-bounded UPDATE/DELETE with no applicable exemption. CAS-by-construction and idempotency preserved.

## D2 — C1 forbidden pattern "exactly one unwrapTeamKey call site": count is 2
The extraction unified getTeamEncryptionKey/getTeamEncryptionKeyForVersion into one helper (the pattern's intent). A second PRE-EXISTING `unwrapTeamKey` call remains in `distributePendingKeys` — an unrelated flow needing raw Uint8Array team-key bytes for re-wrap escrow, not the derived CryptoKey the helper returns. Refactoring it would extend the helper's contract beyond C1's scope. Forbidden-pattern scope interpreted as "no second call site in the key-FETCH paths"; recorded rather than silently widened.

## D3 — C5 UI: implemented (not API-only)
Plan allowed API-only with deviation entry if no natural UI slot existed. A natural slot exists (tenant-members-card next to TenantVaultResetButton) AND the step-up client-coverage gate requires a client `@stepup` marker for `clear-lockout-post` — API-only would leave a red CI gate. UI implemented with the reset-vault button as template.

## D4 — C5 route additions to gate manifests
Bijection/manifest gates required entries not enumerated in the plan: `scripts/checks/stepup-route-paths.json` (clear-lockout-post), `scripts/checks/route-policy-manifest.json`, `scripts/checks/fail-closed-manifest.txt` + EXPECTED_LIMITER_COUNT ratchet 69→71 in check-fail-closed-routes-have-test.sh (two new fail-closed limiters counted). All are the gates doing their job on a new route; recorded for reviewer visibility.

## D5 — C8 packageManager value
`npm@11.17.0` chosen from local `npm -v` on the .nvmrc Node 20 toolchain, per plan's decision-point instruction.

## D6 — sweep-isolation.test.ts call-index side-fix
The C7 pre-step adds one `$transaction` call before the registry loop; the isolation test's mocked call-index counter assumed registry entries start at index 0. Counter adjusted (test-only fix, documented inline).

## D7 — C4 warn logging via console.warn
No logger exists in src/lib/proxy/* (@/lib/logger is pino + node:async_hooks, not Edge-safe). Plan's explicit fallback (console.warn with structured object) applied.

## D8 — Pre-existing lint warnings left (2, untouched files)
`src/app/api/mcp/token/route.test.ts:15` (mockTokenLimiterCheck used only as type via vi.hoisted destructure) and its sibling — pre-existing warnings in files this branch does not touch; lint gate is 0-errors. Anti-Deferral: worst case = cosmetic warning persists; likelihood n/a (no behavior); cost-to-fix here = restructuring an unrelated test's hoisted-mock typing, cheaper in its own change. Carried, not suppressed.

## D9 — Integration-suite flakiness: pre-existing, verified via baseline
Full `npm run test:integration` shows 1-2 intermittent failures per run in DIFFERENT files each run (retention-gc-forensic-credentials cleanup FK 23503; audit-delivery-rate-limit claim count; audit-outbox-skip-locked claim count — SKIP LOCKED/parallel-drain races). Verified by stashing all working changes and re-running on baseline: 1 failure there too. Each failing file passes 100% in isolation. New tests added by this branch (retention-registry-rls-parity 4, access-request-expiry-sweep 3) pass in every run. Root-cause fix of the parallel-drain race is out of scope (pre-existing harness issue, none of the failing paths are touched by this diff); worth a dedicated follow-up.

## D10 — R39 pre-existing residual in fetchAndUnwrapTeamKey (informational)
Self-R-check noted two byte-identical-to-main residuals carried through the C1 extraction: (i) the `!userId` early return skips ecdhPrivateKeyBytes.fill(0) (the bytes are a fresh copy, GC-freed unfilled); (ii) teamKeyBytes stays unfilled if deriveTeamEncryptionKey throws post-unwrap (try-scoped, unreachable from catch). All paths ADDED by this branch fill correctly. Minor defense-in-depth follow-up candidate; not a branch blocker (pre-existing, transient copies, internal-failure-only window).
