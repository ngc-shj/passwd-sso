# Plan: retention-mcp-token-family (SC5)

## Project context
- Type: service (Next.js + Prisma 7 + PostgreSQL 16, multi-tenant RLS, least-privilege worker roles) + the retention-GC worker merged in #571.
- Test infra: unit + integration (real-DB) + CI.
- Verification constraints: VC1 cascade/concurrency on live DB → verifiable-CI; VC2 role grants → verifiable-CI (CI minimal role).

## Objective
Add **family-aware GC** for the MCP OAuth token rotation family — `mcp_access_tokens`, `mcp_refresh_tokens`, and the `delegation_sessions` that hang off access tokens — which #571 deferred (SC5) because `mcp_access_tokens` has `ON DELETE CASCADE` to live dependents: deleting a 1-hour-expired access token would destroy a still-valid 7-day refresh token and active delegation sessions, breaking OAuth refresh-rotation.

## Background facts (verified against schema)
- `mcp_access_tokens`: TTL 1h (max 1d), `expires_at`, `revoked_at` (schema). RLS-enabled (tenant-scoped).
- `mcp_refresh_tokens`: TTL 7d, `family_id`, `access_token_id` FK → `mcp_access_tokens(id) ON DELETE CASCADE` (schema:1969), `expires_at`, `revoked_at`, `rotated_at`. RLS-enabled.
- `delegation_sessions`: `mcp_token_id` FK → `mcp_access_tokens(id) ON DELETE CASCADE` (schema:1990), `expires_at`, `revoked_at`. RLS-enabled.
- TTLs: `MCP_TOKEN_EXPIRY_SEC=1h`, `MCP_REFRESH_TOKEN_EXPIRY_SEC=7d` (src/lib/constants/auth/mcp.ts).

## Technical approach
Add a new registry entry **kind `EXPIRY_GUARDED`** to the existing engine. It is an EXPIRY-shaped delete on a parent table, gated by a **code-defined "no live dependents" guard** (a fixed `NOT EXISTS` subquery literal in sweep.ts — NOT registry data, preserving the S1 SQL-injection containment boundary). The structured `predicate` grammar (column + literal only) cannot express `NOT EXISTS (subquery)`, so the guard lives in code keyed by a small enum, not in the registry row.

Deleting a guarded-eligible `mcp_access_tokens` row cascades its now-dead refresh tokens + delegation sessions via the existing FK CASCADE — which is correct ONCE the guard proves none are live.

### Registry entry
```
interface GuardedExpiryEntry {
  kind: "EXPIRY_GUARDED";
  table: "mcp_access_tokens";
  cutoffColumn: "expires_at";
  keyColumns: ["id"];
  guard: "MCP_TOKEN_FAMILY_DEAD";   // enum selecting a code-defined guard SQL
  globalDelete: true;                // RLS-enabled
}
```

### Guard SQL (code literal in sweep.ts, keyed by guard enum)
```
AND NOT EXISTS (
  SELECT 1 FROM mcp_refresh_tokens r
  WHERE r.access_token_id = mcp_access_tokens.id
    AND r.revoked_at IS NULL AND r.expires_at > now()
)
AND NOT EXISTS (
  SELECT 1 FROM delegation_sessions d
  WHERE d.mcp_token_id = mcp_access_tokens.id
    AND d.revoked_at IS NULL AND d.expires_at > now()
)
```
Effect: an expired access token is deleted ONLY when its whole rotation family + delegation sessions are themselves expired/revoked. The cascade then removes the dead children. Refresh tokens whose access-token parent is already gone (e.g. after rotation `rotated_at` set + old access token deleted) are orphan-safe — they're cascade children, so they vanish with the parent; any that outlive their parent are themselves caught when THEIR family's surviving access token expires.

## Contracts

### C1 — registry kind + entry — locked
- Extend `RetentionEntryKind` with `"EXPIRY_GUARDED"`; add `GuardedExpiryEntry` interface (`guard: GuardName` where `GuardName = "MCP_TOKEN_FAMILY_DEAD"`); add the `mcp_access_tokens` entry.
- Invariants: INV-C1a (DMMF cross-check covers the new entry's table/columns); INV-C1b (guard is a closed enum, NOT free SQL — S1 containment); the boot validator requires `globalDelete:true` (RLS-enabled).
- Forbidden: `pattern: guard\?\s*:\s*string` (guard must be the enum type, never raw SQL).

### C2 — sweepGuardedExpiryEntry — locked
- `sweepGuardedExpiryEntry(tx, entry: GuardedExpiryEntry, batchSize): Promise<number>` — same `(keys) IN (SELECT keys WHERE cutoff < now() AND <guardSql> LIMIT $1)` batch-bounded shape as sweepExpiryEntry, where `<guardSql>` is resolved from `GUARD_SQL[entry.guard]` (a const map of compile-time literals). Identifiers allowlist-validated. bypass_rls set (globalDelete).
- Invariant: the guard subquery columns are all literals; the only bound param is `$1` batchSize.
- Acceptance: unit test asserts generated SQL contains both NOT EXISTS clauses + `LIMIT $1`, params `[batchSize]`.

### C3 — sweepOnce dispatch — locked
- Extend the `sweepOnce` dispatch to an explicit per-kind branch: `EXPIRY` → sweepExpiryEntry, `EXPIRY_GUARDED` → sweepGuardedExpiryEntry, `PER_TENANT_FN` → sweepAuditLogs. **Replace the current elimination-`else` (which treats "not EXPIRY" as PER_TENANT_FN) with an explicit `=== "PER_TENANT_FN"` check** (F1) so a future 4th kind cannot silently misroute. Per-entry isolation unchanged (each in its own tx, errors → -1).

### C4 — DB role grant — locked (corrected per plan review S1)
- New migration: grant `passwd_retention_gc_worker`:
  - `SELECT, DELETE` on `mcp_access_tokens` (the parent the worker deletes).
  - `SELECT` on `mcp_refresh_tokens` and `delegation_sessions` — needed for the guard `NOT EXISTS` subqueries **only**.
- **R14 corrected**: Postgres `ON DELETE CASCADE` is enforced by an internal RI system trigger; the cascaded child delete does **NOT** re-check the invoking role's table privileges, so the worker does **NOT** need `DELETE` on `mcp_refresh_tokens` / `delegation_sessions`. (The prior plan prose claiming otherwise was wrong.) RLS on the cascade-target children (FORCE RLS) is satisfied because the worker sets `app.bypass_rls='on'` in the same tx. Granting child DELETE would over-privilege a least-privilege role — do NOT.
- Acceptance (live DB is the arbiter): with children granted **SELECT-only**, the role CAN delete an eligible access token and the cascade removes the dead children (proving no child DELETE grant is needed); the role CANNOT delete an access token whose family has a live refresh token (guard → 0 rows). Negative control: role CANNOT directly `DELETE FROM mcp_refresh_tokens` (no DELETE grant). CI minimal-role parity.

### C5 — tests — locked
- Unit: guard SQL shape (C2). Integration (real DB): (a) expired access token with NO live family → deleted + cascade removes dead refresh/delegation; (b) expired access token WITH a live refresh token → NOT deleted (guard holds); (c) expired access token WITH a live delegation session → NOT deleted; (d) batchSize cap; (e) role-grant positive+negative.
- RT7 (corrected per review T1): the guard negative tests MUST assert the **live child row survives** the sweep — i.e. assert the live `mcp_refresh_tokens` row (and the live `delegation_sessions` row) still exist after `sweepOnce`, NOT merely that the parent access-token count is unchanged. Reverting the guard makes the parent delete-eligible → cascade destroys the live child → that survival assertion goes red. A parent-count-only assertion would be decorative.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | EXPIRY_GUARDED kind + registry entry | locked |
| C2 | sweepGuardedExpiryEntry (guard SQL from enum) | locked |
| C3 | sweepOnce dispatch | locked |
| C4 | DB role grant (cascade DELETE on 3 tables) | locked |
| C5 | unit + integration tests | locked |

## Considerations
- **Why not just delete refresh tokens by their own expiry?** A refresh token can be live (7d) while its access-token parent is expired (1h). Deleting the parent by parent-expiry alone is the F2 bug. The guard makes parent deletion wait for the whole family.
- **Orphan refresh tokens**: after rotation, the old refresh token is `revoked_at`-marked but its `access_token_id` still points at the (now possibly-deleted) old access token. Cascade handles co-deletion. A revoked refresh token does NOT keep its parent alive (guard checks `revoked_at IS NULL`), so a fully-rotated-away family GCs correctly.
- Out of scope: changing rotation logic; only GC is added.

## Scope contract
- SC4/SC2/SC3/SC6/SC7 remain separate follow-ups.
