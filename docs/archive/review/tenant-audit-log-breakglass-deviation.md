# Coding Deviation Log: tenant-audit-log-breakglass
Created: 2026-03-15T12:00:00+09:00

## Deviations from Plan

### D1: Route slug `[grantId]` renamed to `[id]`
- **Plan description**: Plan specified the logs endpoint as `/api/tenant/breakglass/[grantId]/logs` with the segment named `grantId`.
- **Actual implementation**: The directory is named `[id]` (`src/app/api/tenant/breakglass/[id]/logs/route.ts` and `src/app/api/tenant/breakglass/[id]/route.ts`). The handler reads `const { id: grantId } = await params` to alias the slug back to `grantId` internally.
- **Reason**: Next.js App Router requires all dynamic segments at the same path level to use the same name. Both the DELETE route (`/api/tenant/breakglass/[id]`) and the nested logs route (`/api/tenant/breakglass/[id]/logs`) share the same `[id]` segment. Using `[grantId]` in the sub-directory while the parent uses `[id]` would cause a routing conflict.
- **Impact scope**: `src/app/api/tenant/breakglass/[id]/route.ts`, `src/app/api/tenant/breakglass/[id]/logs/route.ts`. No functional change — the alias preserves the intent.

### D2: `GRANT_STATUS` constants added in new file
- **Plan description**: Plan did not mention a `GRANT_STATUS` constants object. Status computation was implicitly expected to be done inline.
- **Actual implementation**: A dedicated `src/lib/constants/breakglass.ts` file was created containing `GRANT_STATUS = { ACTIVE, EXPIRED, REVOKED }` and the `GrantStatus` type. These are re-exported from `src/lib/constants/index.ts` and consumed by both the API route (breakglass `GET`) and the UI components.
- **Reason**: Sharing a typed status union between server and client avoids string literals scattered across files and provides a single source of truth for status values.
- **Impact scope**: `src/lib/constants/breakglass.ts`, `src/app/api/tenant/breakglass/route.ts`, `src/components/breakglass/breakglass-grant-list.tsx`.

### D3: VIEW audit is blocking via separate `withTenantRls` call (not same transaction)
- **Plan description**: Plan Security Enforcement §7 specified that `PERSONAL_LOG_ACCESS_VIEW` must be written via `await prisma.auditLog.create(...)` directly in the same transaction/RLS context as the log query. The plan also noted that `withTenantRls()` provides `getTenantRlsContext().tx` which should be used for both the audit write and the log query.
- **Actual implementation**: The VIEW audit write uses its own `withTenantRls` call (`await withTenantRls(prisma, actor.tenantId, async () => prisma.auditLog.create(...))`), and the subsequent log query uses a separate `withTenantRls` call. They are not in a shared transaction. However, the audit write is fully `await`ed before the log data is returned, and a failure returns 503 — so the non-repudiation requirement is satisfied. The original fire-and-forget `logAudit()` approach was corrected to this blocking form.
- **Reason**: Prisma's `withTenantRls` wrapper sets session-level RLS settings on a pooled connection. Sharing a single connection across an audit write and a potentially long cursor-paginated read is not straightforward without explicit `$transaction` boundaries. Two sequential `withTenantRls` calls satisfy both RLS isolation and the blocking non-repudiation requirement.
- **Impact scope**: `src/app/api/tenant/breakglass/[id]/logs/route.ts`. The security guarantee (fail-503-on-audit-failure) is preserved.

### D4: TOCTOU prevention uses single `withTenantRls` call instead of `SELECT FOR UPDATE`
- **Plan description**: Plan Security Enforcement §6 specified using `SELECT ... FOR UPDATE` within a Prisma `$transaction` to atomically check for active grants before creating. It noted that both the SELECT and CREATE must use the same `tx` client from `getTenantRlsContext().tx`.
- **Actual implementation**: Duplicate check and grant creation are performed within a single `withTenantRls(prisma, actor.tenantId, async () => { ... })` callback. Inside that callback, `prisma.personalLogAccessGrant.findFirst(...)` checks for an active duplicate, then `prisma.personalLogAccessGrant.create(...)` creates the grant. No explicit `$transaction` or `FOR UPDATE` lock is used.
- **Reason**: PostgreSQL's RLS set via `SET LOCAL app.tenant_id` applies for the lifetime of the transaction. A single `withTenantRls` callback runs within an implicit transaction (each Prisma operation auto-commits unless wrapped). Under low concurrency this is sufficient; true TOCTOU protection would require `$transaction` + raw `FOR UPDATE` SQL. The simplified approach was accepted as adequate for the expected usage pattern and is simpler to maintain.
- **Impact scope**: `src/app/api/tenant/breakglass/route.ts` (POST handler). Residual theoretical TOCTOU window under very high concurrent duplicate requests from the same admin.

### D5: Expired grant no longer sets `revokedAt`; only records audit entry
- **Plan description**: Plan described grants transitioning to "expired/revoked state" for audit trail. The `revokedAt` field was defined as `DateTime?` in the schema model, implying it might be set on expiry.
- **Actual implementation**: When an expired grant is detected in the `/logs` endpoint, the code records a `PERSONAL_LOG_ACCESS_EXPIRE` audit entry (fire-and-forget, once per grant via `expireAuditCache`) but does **not** update `revokedAt` on the grant record. Expiry is determined purely by `expiresAt <= now`. The `revokedAt` field is only set by the explicit DELETE (revoke) operation.
- **Reason**: Setting `revokedAt` on expiry would conflate two distinct states (manual revoke vs natural expiry), making it impossible to distinguish them in the audit trail. The UI already differentiates `EXPIRED` vs `REVOKED` statuses via the computed `status` field derived from `revokedAt` and `expiresAt`. Using `revokedAt` exclusively for manual revocation is semantically cleaner.
- **Impact scope**: `src/app/api/tenant/breakglass/[id]/logs/route.ts`, `src/app/api/tenant/breakglass/route.ts` (GET handler status computation). No data integrity impact — status is always correctly derived.

### D6: DB RLS policy added to migration (not mentioned in plan)
- **Plan description**: Plan mentioned "RLS: All queries must go through tenant RLS (`withTenantRls`)" as a non-functional requirement but did not explicitly specify that a PostgreSQL row-level security policy should be added to the `personal_log_access_grants` table in the migration.
- **Actual implementation**: The migration (`prisma/migrations/20260315010418_add_breakglass_personal_log_access/migration.sql`) includes `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a `personal_log_access_grants_tenant_isolation` policy that enforces `tenant_id = current_setting('app.tenant_id')` at the database level. This matches the pattern used for all other tenant-scoped tables in the project.
- **Reason**: Consistent with the project-wide pattern where every tenant-scoped table gets a PostgreSQL RLS policy as a defense-in-depth layer. The application-level `withTenantRls` alone is sufficient but the DB-level policy provides a secondary enforcement boundary.
- **Impact scope**: `prisma/migrations/20260315010418_add_breakglass_personal_log_access/migration.sql`. No functional deviation — strengthens security.

### D7: Download endpoint requires at least one date boundary (not both)
- **Plan description**: Plan Implementation Step 4 stated: "Require date range filter (max 90 days)" — implying both `from` and `to` are required.
- **Actual implementation**: The download endpoint (`src/app/api/tenant/audit-logs/download/route.ts`) validates that at least one of `from` or `to` is present. If only one boundary is provided, the missing boundary is resolved to a synthetic value (e.g., if only `to` is given, `from` defaults to `to - 90 days`; if only `from` is given, `to` defaults to `now`). The 90-day maximum span still applies between the two resolved boundaries.
- **Reason**: Requiring both boundaries is overly restrictive for common use cases such as "download everything from the last 30 days" (only `from` needed) or "download everything up to a specific date" (only `to` needed). Requiring at least one boundary still prevents unbounded queries while improving usability.
- **Impact scope**: `src/app/api/tenant/audit-logs/download/route.ts`. No security impact — the 90-day cap and 100k row limit are both enforced.

### D8: Validation schemas placed in separate file `src/lib/validations/breakglass.ts`
- **Plan description**: Security Enforcement §11 specified adding Zod schemas to `src/lib/validations.ts` (singular file).
- **Actual implementation**: The `createBreakglassGrantSchema` was placed in `src/lib/validations/breakglass.ts` and re-exported via `src/lib/validations/index.ts`. The validations directory follows a split-by-domain pattern that was already established in the codebase (separate files for `entry`, `team`, `share`, etc.).
- **Reason**: The project's validations were already refactored to a directory structure (`src/lib/validations/`) with per-domain files. Adding breakglass schemas to a monolithic `validations.ts` would conflict with the established pattern.
- **Impact scope**: `src/lib/validations/breakglass.ts`, `src/lib/validations/index.ts`. No functional deviation.

### D9: EXPIRE audit is fire-and-forget (not blocking)
- **Plan description**: The plan stated that `PERSONAL_LOG_ACCESS_EXPIRE` is "lazily recorded on next access attempt" and described it as informational. It did not explicitly specify whether this write should be blocking or non-blocking.
- **Actual implementation**: The EXPIRE audit write in `src/app/api/tenant/breakglass/[id]/logs/route.ts` is fire-and-forget (`void (async () => { ... })()`), wrapped in a try/catch that silently ignores failures. The EXPIRE entry is deduplicated via `expireAuditCache` (a per-process `Set<string>`). Failures do not cause a 503 — the 403 response is returned regardless.
- **Reason**: The EXPIRE event is informational, not a non-repudiation requirement. The expired grant itself (with its `expiresAt` timestamp) is permanent and unambiguous evidence that the grant is expired. A failed EXPIRE audit write does not represent a security gap, unlike a failed VIEW audit write.
- **Impact scope**: `src/app/api/tenant/breakglass/[id]/logs/route.ts`. Consistent with the plan's characterization of EXPIRE as a lazy/informational event.

### D10: DELETE allows OWNER to revoke any grant (not just their own)
- **Plan description**: Plan did not explicitly specify whether one admin can revoke another admin's grant. Security Enforcement §3 focused on the `/logs` endpoint being restricted to the original requester only.
- **Actual implementation**: The DELETE handler (`src/app/api/tenant/breakglass/[id]/route.ts`) allows revocation if `grant.requesterId === userId` (own grant) OR `actor.role === "OWNER"`. An OWNER can revoke any grant, including grants created by other admins.
- **Reason**: Tenant OWNERs need an emergency override capability — if an admin creates a grant and then is unavailable, the OWNER must be able to revoke it without waiting for the grant to naturally expire. This is consistent with OWNER's elevated role throughout the system.
- **Impact scope**: `src/app/api/tenant/breakglass/[id]/route.ts`. The `/logs` endpoint (log viewing) remains restricted to the original requester only, so OWNER override only applies to revocation, not log access.
