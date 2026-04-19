# Coding Deviation Log: enforce-audit-base-helper-usage

## D1: mcp/register/route.ts moved to Bucket C (was Batch 2)

**Plan**: Batch 2 listed `src/app/api/mcp/register/route.ts` for Pattern 2 migration.

**Reality**: The route emits a TENANT-scope event WITHOUT `tenantId` (`audit.ts` lines around 174). The MCP DCR (Dynamic Client Registration) endpoint operates BEFORE the client is bound to a tenant — there is no tenantId available at the call site. `tenantAuditBase(req, userId, tenantId)` requires tenantId as the third arg. The current code relies on `resolveTenantId()` looking up by `SYSTEM_ACTOR_ID` (which returns null and dead-letters the event).

**Decision**: Bucket C — same category as `internal/audit-emit/route.ts` (TENANT-scope without tenantId). Migration would require an unreviewed extra DB lookup.

**Audit chain impact**: None — the event already dead-letters; no persisted audit_logs row exists pre- or post-migration.

## D2: vault/admin-reset Pattern 4 — explicit tenantId override after helper spread

**Plan**: Pattern 4 example showed `...(resetRecord.teamId ? teamAuditBase(...) : tenantAuditBase(req, userId, tenantId)), action, ...`.

**Reality**: The TEAM-scope helper does NOT set `tenantId`, but the existing test `vault/admin-reset/route.test.ts:222-236` asserts `tenantId: "tenant-1"` on the TEAM-scope event. Without explicit override, the test fails (same root cause as F1/Pattern 5 in the plan).

**Decision**: Add `tenantId: resetRecord.tenantId` after the helper spread. Behavior-preserving; matches the F1 mandatory-tenantId rule documented for Pattern 5.

```ts
await logAuditAsync({
  ...(resetRecord.teamId
    ? teamAuditBase(req, session.user.id, resetRecord.teamId)
    : tenantAuditBase(req, session.user.id, resetRecord.tenantId)),
  tenantId: resetRecord.tenantId,  // ← preserved for TEAM emit (helper omits it)
  action: ...,
});
```

**Lesson**: Pattern 4 (conditional team/tenant) needs the same mandatory tenantId-preservation rule as Pattern 5 (dual emit) — for the same reason (helper omits it on TEAM scope, but JSON log + tests need it). Plan should be updated for future references.

## D3: vault/admin-reset test — TENANT-scope `teamId: undefined` assertion replaced

**Plan**: "No new tests required."

**Reality**: `vault/admin-reset/route.test.ts:249-255` test "uses TENANT scope when teamId is null" asserted `expect.objectContaining({ teamId: undefined })`. Pre-migration the code explicitly set `teamId: resetRecord.teamId ?? undefined` (key present with undefined value). Post-migration `tenantAuditBase()` does not include the `teamId` key at all. `objectContaining` is strict about key presence; the test failed.

**Decision**: Replace the assertion with `lastCall?.teamId).toBeUndefined()` which matches absent-key semantics. The persisted `audit_logs.teamId` column is identical pre/post (always null for TENANT-scope), so behavior is preserved.

```ts
// Before:
expect(mockLogAudit).toHaveBeenCalledWith(
  expect.objectContaining({ scope: "TENANT", tenantId: "tenant-1", teamId: undefined }),
);

// After:
expect(mockLogAudit).toHaveBeenCalledWith(
  expect.objectContaining({ scope: "TENANT", tenantId: "tenant-1" }),
);
const lastCall = mockLogAudit.mock.calls[...]?.[0] as Record<string, unknown> | undefined;
expect(lastCall?.teamId).toBeUndefined();
```

**Lesson**: `expect.objectContaining({ key: undefined })` asserts an implementation detail (key presence), not the persisted value. Future migrations should not preserve such assertions when they constrain helper-spread shape unnecessarily.

## D4: 18 test mock files — added explicit helper mocks (R19, predicted in plan)

**Plan**: §Testing strategy claimed "Existing `extractRequestMeta` mocks transparently apply to helper-using sites — no mock updates required."

**Reality**: This was incorrect. `vi.mock("@/lib/audit", () => ({ ... }))` creates a flat mock — the helpers (which live in the same module) are NOT auto-exposed. Internal calls within the audit module to `extractRequestMeta` would also bypass the mock per JS module semantics, but the immediate breakage is `tenantAuditBase is not defined on the mock`.

**Decision**: Updated 18 test files to explicitly include `personalAuditBase`, `teamAuditBase`, `tenantAuditBase` in the mock object, returning shapes matching the file's existing `extractRequestMeta` mock (e.g., `{ scope, userId, ip: "127.0.0.1", userAgent: "Test" }`).

**Files affected**:
- `src/__tests__/api/share-links/{delete,route}.test.ts`
- `src/app/api/admin/rotate-master-key/route.test.ts`
- `src/app/api/audit-logs/export/route.test.ts`
- `src/app/api/extension/token/exchange/route.test.ts`
- `src/app/api/maintenance/{purge-audit-logs,purge-history}/route.test.ts`
- `src/app/api/mcp/authorize/consent/route.test.ts`
- `src/app/api/scim/v2/{Groups/[id],Users/[id],Users}/route.test.ts`
- `src/app/api/share-links/{[id],verify-access}/route.test.ts`
- `src/app/api/tenant/access-requests/route.test.ts`
- `src/app/api/vault/{admin-reset,delegation/check,delegation}/route.test.ts`
- `src/app/api/watchtower/alert/route.test.ts`

**Lesson**: R19 obligation in the recurring-issue checklist exists for exactly this reason. Plan §Testing strategy was wrong about mock transparency; future plans for helper migrations should plan for explicit mock updates upfront.

## D5: extension/token/exchange — ip placeholder "unknown" → null

**Plan**: §Functional 2 EXCEPTION enumerated only `MASTER_KEY_ROTATION` and `MCP_CLIENT_DCR_CLAIM` as forensic-upgrade sites.

**Reality**: `extension/token/exchange/route.ts` lines 154/176 previously passed `ip` (a local variable that defaults to `"unknown"` for rate-limit purposes when extractClientIp returns null). After helper migration, `personalAuditBase()` calls `extractRequestMeta()` which returns the real IP or `null` — never the rate-limit placeholder.

**Decision**: Treat as a small forensic correction. The persisted `audit_logs.ip` column transitions from `"unknown"` to `null` for events where the caller IP cannot be determined. `null` is the more accurate signal (no IP) than the misleading `"unknown"` string.

**Audit chain impact**: One-event hash continuity transition for any pre-migration request that had no determinable IP. Negligible — most requests have IP headers set.

## D6: Bucket B inventory final count

**Plan**: 23 source files / ~55 calls (after moving `internal/audit-emit` to Bucket C).

**Reality**: 22 source files / ~52 calls (after also moving `mcp/register` to Bucket C per D1).

**Decision**: Plan inventory accurate-enough; final implementation reflects the live count. No re-scope needed.
