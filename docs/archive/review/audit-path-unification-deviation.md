# Coding Deviation Log: audit-path-unification
Created: 2026-04-15

## Deviations from Plan

### D1: `SHARE_ACCESSED` action not present; SHARE group uses 4 actions
- **Plan description**: MF11.b listed `TENANT_WEBHOOK_EVENT_GROUPS.SHARE` containing 5 actions including `SHARE_ACCESSED`.
- **Actual implementation**: `SHARE_ACCESSED` does not exist in `AUDIT_ACTION`. The SHARE group registered in `TENANT_WEBHOOK_EVENT_GROUPS` contains 4 actions: `SHARE_ACCESS_VERIFY_FAILED`, `SHARE_ACCESS_VERIFY_SUCCESS`, `SHARE_CREATE`, `SHARE_REVOKE`.
- **Reason**: Plan authoring used a placeholder name. Using the actually-defined action names matches the existing pattern in `AUDIT_ACTION_GROUPS_PERSONAL` and `AUDIT_ACTION_GROUPS_TEAM`.
- **Impact scope**: Tenant webhook subscribers to SHARE will receive the four events listed above. The core security goal (SIEM fan-out of `SHARE_ACCESS_VERIFY_FAILED` for brute-force detection) is preserved.

### D2: `AuditActorTypeBadge` gained `userId` prop; sentinel-UUID override added
- **Plan description**: MF13 called for a central `resolveActorDisplay` helper used by the UI.
- **Actual implementation**: The new helper lives in `src/lib/audit-display.ts`. The badge component accepts optional `userId` and delegates to `resolveActorDisplay` before falling back to actorType-based rendering. Three existing call sites updated to pass `userId={log.user?.id}`.
- **Reason**: Needed to thread userId into the badge because the sentinel decision depends on userId, not actorType alone.
- **Impact scope**: No behavior change for rows with real user UUIDs (helper returns `{i18nKey: null, isSentinel: false}`). For sentinel rows, the badge now shows "Anonymous" / "System" via the central helper.

### D3: `parsePayload` in outbox worker falls back to `""` instead of `null`
- **Plan description**: Plan MF7 said "keep the guard as defense-in-depth". Implementation kept the guard but had to reconcile the newly non-nullable `userId: string` type.
- **Actual implementation**: When the deserialized outbox payload has a non-string `userId` (malformed row, should not occur), `parsePayload` coerces to empty string `""`. The existing `userId === null` guards at L942/L959 of the worker therefore will NOT fire for such rows — but the subsequent INSERT will fail at the PostgreSQL UUID cast, producing a hard error that drives the row to dead-letter via the normal error path.
- **Reason**: Changing the type from `string | null` → `string` required a fallback that satisfies the type. Throwing at parse time was considered but would bypass the dead-letter machinery; empty string lets the normal retry/DLQ path handle it.
- **Impact scope**: The null-userId defense-in-depth guards at L942/L959 are effectively unreachable from both `logAuditAsync` (type system blocks null entry) and `parsePayload` (converts null to `""`). They remain in the code as guards against future direct outbox inserts by external tooling. Consider rewriting them as `!UUID_RE.test(payload.userId)` guards in a follow-up.

### D4: `audit-logs` route shapes unchanged for human rows; sentinel rows get `user: null`
- **Plan description**: Batch 2 task mandated switching from ORM `include: { user }` to a separate `prisma.user.findMany` lookup. Sentinel exclusion was flagged.
- **Actual implementation**: All 6 affected routes (personal/team/tenant audit logs + breakglass + 2 download streams) filter the IDs via `SENTINEL_ACTOR_IDS` before calling `user.findMany`, then merge the result. Rows whose `userId` is a sentinel receive `user: null` in the response shape.
- **Reason**: Matches MF13 (display helper owns sentinel rendering; API leaves `user: null` and the UI resolves via i18n).
- **Impact scope**: Tests asserting `user.email` on SYSTEM/ANONYMOUS rows needed updating. Human rows continue to have the full `user` object. Download routes perform per-batch user lookups inside the stream loop to bound memory.

### D5: `audit-and-isolation.test.ts` action rename
- **Plan description**: T12 said not to add ANONYMOUS isolation tests here.
- **Actual implementation**: The existing test used `ENTRY_VIEW` which did not exist in `AUDIT_ACTION`; replaced with `ENTRY_EXPORT`. Added a `: string` type annotation to bypass a literal-type comparison error unrelated to this refactor.
- **Reason**: Pre-existing test bug surfaced by compile check; fixed minimally per CLAUDE.md rule "Fix ALL errors".
- **Impact scope**: Test file only; no runtime behavior changes.

### D6: `audit_deliveries` assertion deferred in manual test script
- **Plan description**: Step 13 asked to add an audit_deliveries row check when a tenant has a configured delivery target.
- **Actual implementation**: Omitted; the script does not know whether the test tenant has a configured target.
- **Reason**: Requires additional setup state not available in the current script scope.
- **Impact scope**: Operational verification only. Add as a follow-up once the dev environment has a standard delivery target fixture.

### D7: Scenario 6 (worker guard unreachable) expressed as DB-level assertion
- **Plan description**: Step 12 scenario 6 asked to instrument worker logs and assert `worker.system_actor_null_userid_skipped` is never emitted for 100 ANONYMOUS events.
- **Actual implementation**: `audit-sentinel.integration.test.ts` verifies the guard's unreachability indirectly: it asserts that ANONYMOUS rows inserted via the outbox path produce audit_logs entries (i.e., the worker processes them without skipping).
- **Reason**: Spawning the worker process from a Vitest integration test is out of the project's existing test harness pattern.
- **Impact scope**: Direct log instrumentation is deferred; the invariant is still indirectly covered.
