# Coding Deviation Log: tenants-table-rls

## D1 — `pgErrorCode` read the wrong adapter field (side-fix, production)

- Found by: the C4 integration cell asserting SQLSTATE 23503 for an `audit_outbox` FK violation raised
  through the model API; `pgErrorCode` returned `null`.
- Cause: `@prisma/adapter-pg` reports `{ originalCode, originalMessage, ...mapDriverError(error) }`;
  the per-kind branches add no `code`. `pgErrorCode` read `cause.code` first, so every model-API
  error resolved to `null`; raw-query errors resolved only through the rendered message text.
  `classifySentinelTenantConstraint` (sign-in, `users_not_system_tenant`) was therefore dead.
  The `helpers.test.ts` fixture carried the same stale shape.
- Change: `src/lib/prisma/prisma-error.ts` reads `cause.originalCode` first, `cause.code` as a
  fallback; `helpers.test.ts` fixture corrected, a legacy-shape cell kept.
- Red proof: on a scratch copy with the previous `prisma-error.ts`, `helpers.test.ts` fails 5 cells;
  with the fix it passes. Separate commit.

## D2 — the verifier never verified `__system__` and errored on it every tick (side-fix, production)

- Found by: the C3 integration cell (`runTick` as `passwd_app`, `erroredTenantCount` expected 0).
- Cause: `runTick` enumerates `__system__`; `verifyTenantChain` opens `withTenantRls`, whose
  `assertOpenableTenantContext` refuses the sentinel by design. Every tick has reported
  `erroredTenantCount >= 1`, which trips the deployed high-severity alert permanently.
- Change: the sentinel stays in the raw enumeration (so the empty-enumeration check keeps its
  meaning) but is excluded from `tenantCount` and both counters — not counted as verified, since
  nothing about its chain is read. Its `audit_chain_enabled` is false (a retention migration
  refuses otherwise). `alerts.md` documents it. The sub-agent's first version counted it as
  verified; replaced by the orchestrator because that claims a verification that did not run.
- Anti-Deferral: verifying the sentinel's chain (under a bypass) is out of scope — worst case: if
  its chain were ever enabled, the verifier would not cover it (pre-existing: it never has).
  Cost to fix here: a new grant and a second verification path. Follow-up issue.

## D3 — `sweep-bypass-assert.test.ts`: own describe block for `listTrashRetentionTenants`

- The shared `MEMBERS` harness asserts `resolves.toBe(0)` (a write count); the new member returns a
  tenant list. Same deny/allow/error-propagation coverage in its own block.

## D4 — test fixtures that assumed `tenants` had no policy

- `tenant-claim.integration.test.ts`: its throwaway probe role deletes a tenant and now needs
  EXECUTE on `rls_bypass_admits` like every real role.
- `pre-pr-rls-whitelist.test.mjs`: allow-list alternation gains `TENANTS-SEED`; `TENANTS` pinned fatal.
- `check-sentinel-tenant-literal-parity`: `alerts.md` now spells the sentinel UUID 8 times (each
  runbook query plus its `SET LOCAL app.tenant_id`); gate count and fixture updated.
- `sweep-bypass-source.test.ts`: its AST-derived member set picked up `listTrashRetentionTenants`.

## D5 — the C6 verify block sits as Blocks 1b / 1c

- Placed between Block 1 and Block 2, as planned ("before Block 2's first `SET LOCAL`"), named 1b
  (fatal `[E-RLS-TENANTS]`) and 1c (seed-dependent `[E-RLS-TENANTS-SEED]`).
