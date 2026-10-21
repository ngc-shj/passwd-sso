# Coding Deviation Log: tenants-table-rls

## D1 — `pgErrorCode` read the wrong adapter field (side-fix, production)

- Found by: the C4 integration cell asserting SQLSTATE 23503 for an `audit_outbox` FK violation raised
  through the model API; `pgErrorCode` returned `null`.
- Cause: `@prisma/adapter-pg` reports `{ originalCode, originalMessage, ...mapDriverError(error) }`.
  `mapDriverError`'s `default:` branch adds a sibling `code`; its named branches (22001, 22003,
  22P02, 23505, 23502, 23503, 23001, 3D000, 28000, 28P01, 40001, 40P01, 42P01, 42703, 42P04,
  53300) do not. `pgErrorCode` read `cause.code` first, so for those SQLSTATEs a model-API error
  resolved to `null`; raw-query errors recovered them only through the rendered message text.
  Unmapped SQLSTATEs (23514 — `classifySentinelTenantConstraint` — 55P03, 42501) were never
  affected. The first version of this entry (and the code comment) claimed `cause.code` was always
  absent and CF13 dead; the Phase 2 self-check refuted that against the adapter source, and both
  texts were corrected.
- Change: `src/lib/prisma/prisma-error.ts` reads `cause.originalCode` first, `cause.code` as the
  live fallback; `helpers.test.ts` fixture labels corrected; `prisma-error.test.ts` gains the
  named-kind (`originalCode`-only) shape.
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

## D6 — `scripts/manual-tests/mcp-replay-audit-verification.ts` unchanged

- Its tenant read runs under `withTenantRls(NIL_UUID)`, which the policy would hide, but the script
  connects through `MIGRATION_DATABASE_URL` as the superuser (stated in its header), which bypasses
  RLS. Unaffected; the plan's member-set table omitted it for that reason without saying so.

## D7 — migration header comment not amended

- The header says a query that set neither scope "sees nothing"; precisely, it sees no rows on a
  fresh connection and raises 22P02 on one whose `app.tenant_id` reverted to `''` (plan R3). The
  migration is already applied to the dev database, and editing an applied migration makes Prisma
  report it as modified, so the imprecision stays in the header; plan R3, `alerts.md` and the
  worker comments state the two outcomes correctly.

## D8 — negative test gains Case 16

- Self-check finding: the fatal `[E-RLS-TENANTS]` had no case that drove it red. Cases 15/16 now
  share one snapshot/restore function; Case 16 widens the policy to `bypass OR true` (symmetric, so
  Block 1 passes) and expects `[E-RLS-TENANTS]`. Checked against the dev DB in a rolled-back
  transaction: under the widened policy a no-context `passwd_app` read sees every tenant.
