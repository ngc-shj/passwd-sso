# Plan: Tenant Audit Log with Break-Glass Personal Log Access

## Objective

Add tenant-level audit log UI and a Break-Glass mechanism that allows tenant admins to access individual users' personal audit logs with mandatory justification, time-limited grants, and full audit trail.

## Requirements

### Functional Requirements

1. **Tenant Audit Log Tab**: Add an "Audit Log" tab to the existing tenant settings page (`/dashboard/tenant`) showing TENANT + TEAM scoped logs
2. **Break-Glass Personal Log Access**: Tenant ADMIN/OWNER can request access to a specific user's personal audit logs by providing a mandatory reason
3. **Time-Limited Grants**: Each grant expires after 24 hours; extension requires a new request with a new reason
4. **Target User Notification**: The target user receives a notification when their personal logs are accessed
5. **Audit the Auditor**: All Break-Glass operations (request, revoke, expire) are recorded as audit log entries
6. **Grant Management UI**: Active grants are visible in the tenant audit log tab; admins can manually revoke grants early
7. **Personal Log Viewer**: When a grant is active, the admin can view the target user's personal logs (read-only, same UI as the personal audit log page)
8. **CSV/JSONL Export**: Tenant audit logs support the same export formats as personal/team logs

### Non-Functional Requirements

1. **Privacy**: Personal logs are never visible without an active, justified grant
2. **Transparency**: All access is logged and the target user is notified
3. **Consistency**: Reuse existing audit log UI components and patterns where possible
4. **i18n**: All new strings must be added to both `messages/en.json` and `messages/ja.json`
5. **RLS**: All queries must go through tenant RLS (`withTenantRls`)

## Technical Approach

### Data Model

#### New Prisma Model: `PersonalLogAccessGrant`

```prisma
model PersonalLogAccessGrant {
  id           String    @id @default(cuid())
  tenantId     String    @map("tenant_id")
  requesterId  String    @map("requester_id")
  targetUserId String    @map("target_user_id")
  reason       String    @db.Text
  incidentRef  String?   @map("incident_ref") @db.VarChar(500)
  expiresAt    DateTime  @map("expires_at")
  revokedAt    DateTime? @map("revoked_at")
  createdAt    DateTime  @default(now()) @map("created_at")

  tenant     Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  requester  User   @relation("BreakGlassRequester", fields: [requesterId], references: [id], onDelete: Restrict)
  targetUser User   @relation("BreakGlassTarget", fields: [targetUserId], references: [id], onDelete: Restrict)

  // No @@unique — uniqueness of active grants enforced at application level
  // via SELECT ... FOR UPDATE in a transaction (see Security Enforcement §6)
  @@index([tenantId, targetUserId])
  @@index([requesterId])
  @@index([expiresAt])
  @@index([requesterId, targetUserId, tenantId])
  @@map("personal_log_access_grants")
}
```

#### New Audit Actions (add to `AuditAction` enum)

```
PERSONAL_LOG_ACCESS_REQUEST   — grant created (scope: TENANT, userId: admin)
PERSONAL_LOG_ACCESS_VIEW      — admin actually viewed personal logs (scope: TENANT, userId: admin; synchronous await — fail = 503)
PERSONAL_LOG_ACCESS_REVOKE    — grant manually revoked (scope: TENANT, userId: admin)
PERSONAL_LOG_ACCESS_EXPIRE    — grant expired, lazily recorded on next access attempt (scope: TENANT, userId: admin)

All 4 actions belong to a new AUDIT_ACTION_GROUP.BREAKGLASS group in AUDIT_ACTION_GROUPS_TENANT.
The userId field always records the admin (requester), not the target user.
Target user info is stored in metadata: { targetUserId, targetUserEmail }.
```

#### New Notification Type

```
PERSONAL_LOG_ACCESSED
```

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tenant/audit-logs` | GET | Tenant-scoped audit logs (TENANT + TEAM scope) |
| `/api/tenant/audit-logs/download` | GET | Export tenant audit logs (CSV/JSONL) |
| `/api/tenant/breakglass` | GET | List active/expired grants |
| `/api/tenant/breakglass` | POST | Create a new Break-Glass grant |
| `/api/tenant/breakglass/[id]` | DELETE | Revoke a grant early |
| `/api/tenant/breakglass/[grantId]/logs` | GET | View target user's personal logs (requires active grant; server enforces `expiresAt` and `revokedAt` check) |

### UI Components

#### 1. Tenant Settings Page Changes (`/dashboard/tenant`)

- Add 5th tab "Audit Log" to the existing `TabsList` (change from `grid-cols-4` to `grid-cols-5`)
- Tab content: `<TenantAuditLogCard />`

#### 2. `TenantAuditLogCard` Component

Two sections:
- **Tenant & Team Logs**: Reuse the same log list pattern as existing audit log pages with tenant-specific action groups (`AUDIT_ACTION_GROUPS_TENANT` already exists + team groups)
- **Break-Glass Section**: Button to open Break-Glass dialog, list of active grants with status

#### 3. `BreakGlassDialog` Component

- User selector (dropdown of tenant members)
- Reason textarea (required, min 10 chars)
- Incident reference input (optional)
- Warning text: "This action will be recorded and the user will be notified"
- Submit button

#### 4. `BreakGlassGrantList` Component

- Table of grants: requester, target user, reason, created, expires, status (active/expired/revoked)
- Revoke button for active grants
- "View Logs" button for active grants → opens personal log viewer

#### 5. `BreakGlassPersonalLogViewer` Component

- Read-only view of target user's personal logs
- Reuses the same log rendering logic as the personal audit log page
- Banner at top: "Viewing [user]'s personal logs — Grant expires at [time]"
- Note: encrypted entry names will NOT be decryptable (admin doesn't have user's encryption key), so show "[Encrypted]" placeholder

### Security Enforcement

1. **Server-side grant validation**: The `/api/tenant/breakglass/[grantId]/logs` endpoint MUST check `expiresAt > now()` AND `revokedAt IS NULL` before returning any data. The UI check is cosmetic only.
2. **Role enforcement**: All Break-Glass and tenant audit log endpoints require `TenantRole.ADMIN` or `TenantRole.OWNER`. The `TENANT_PERMISSION` constants are for fine-grained permission checks within that role.
3. **Grant ownership**: Only the original requester can use the `/logs` endpoint for their grant. Other admins can see grants in the list but cannot use them to view logs. Grant lookup query MUST include `where: { id: grantId, tenantId: actor.tenantId, requesterId: session.user.id }` to prevent cross-tenant access.
4. **Rate limiting**: POST `/api/tenant/breakglass` is limited to 5 grant creations per admin per hour to prevent abuse.
5. **No self-access**: Server rejects grants where `requesterId === targetUserId`.
6. **Duplicate prevention**: Use `SELECT ... FOR UPDATE` within a Prisma `$transaction` to atomically check for active grants (`revokedAt IS NULL AND expiresAt > now()`) before creating a new one. This prevents TOCTOU race conditions. Implementation note: when using `withTenantRls()`, the callback receives the transaction client via `getTenantRlsContext().tx`. The SELECT FOR UPDATE and CREATE must both use this `tx` client within the same `withTenantRls` call, not separate calls.
7. **View auditing**: Every call to `/api/tenant/breakglass/[grantId]/logs` records a `PERSONAL_LOG_ACCESS_VIEW` audit entry. Because the existing `logAudit()` is a fire-and-forget void function that cannot be awaited, the `/logs` endpoint must use `await prisma.auditLog.create(...)` directly within the same transaction/RLS context. If this write fails, return 503 — Break-Glass access requires non-repudiation. Do NOT use `logAudit()` for this endpoint.
8. **CSRF protection**: All POST/DELETE endpoints must call `assertOrigin(req)` as the first operation, following existing patterns (e.g., `reset-vault/route.ts`).
9. **Deactivated user check**: `/logs` endpoint checks that the target user's `TenantMember.deactivatedAt IS NULL` (not `User.deactivatedAt` — the field lives on `TenantMember`, not `User`). Grant creation also rejects deactivated targets by querying `TenantMember` where `userId = targetUserId AND tenantId = tenantId AND deactivatedAt IS NULL`.
10. **RLS strategy for personal log viewing**: Use `withTenantRls(prisma, tenantId, fn)` for tenant isolation, combined with explicit `where: { userId: grant.targetUserId, scope: PERSONAL }` in the query. This 2-layer approach (RLS + app-level filter) ensures tenant isolation without bypassing RLS while correctly reading another user's logs within the same tenant.
11. **Input validation**: Add Zod schemas in `src/lib/validations.ts`: `reason: z.string().trim().min(10).max(1000)`, `incidentRef: z.string().trim().max(500).optional()`.

### Constants Updates

- Add `AUDIT_ACTION_GROUP.BREAKGLASS` and corresponding `AUDIT_ACTION_GROUPS_TENANT` entries
- Add new `AUDIT_ACTION` constants to `AUDIT_ACTION` object, `AUDIT_ACTION_VALUES` array, AND the Prisma `AuditAction` enum in `schema.prisma`
- Add `TENANT_PERMISSION.AUDIT_LOG_VIEW` permission
- Add `TENANT_PERMISSION.BREAKGLASS_REQUEST` permission
- Update `AUDIT_ACTION_GROUPS_TENANT` exhaustive tests

### Expiration Handling

Grants expire passively — no background job needed. The `expiresAt` field is checked:
- On every `/logs` API call (server-side, authoritative)
- On UI render (client-side, cosmetic — shows "Expired" badge)

If an admin attempts to view logs for an expired grant, the server returns 403 and lazily records a `PERSONAL_LOG_ACCESS_EXPIRE` audit log entry (once per grant).

### View Audit Deduplication

To prevent excessive noise from `PERSONAL_LOG_ACCESS_VIEW` entries (e.g., admin paging through many pages of logs), the VIEW action is deduplicated using an in-memory approach: the `/logs` endpoint maintains a server-side cache (e.g., `Map<string, number>` keyed by `grantId`, storing last-recorded timestamp). Record a VIEW entry only if no entry was recorded for the same grant within the last hour. This avoids expensive `metadata` JSON field queries on the `AuditLog` table (which has no index on JSON content). The cache is per-process and resets on server restart, which is acceptable — worst case, an extra VIEW entry is recorded after restart.

### Notification

When a Break-Glass grant is created, send a `PERSONAL_LOG_ACCESSED` notification to the target user containing:
- Who requested access (requester name/email)
- The stated reason
- When the grant expires

## Implementation Steps

1. **Schema migration**: Add `PersonalLogAccessGrant` model, new `AuditAction` enum values, new `NotificationType` value
2. **Constants**: Add new audit actions, action groups, tenant permissions
3. **API: `/api/tenant/audit-logs`** (GET): Tenant-scoped log listing with cursor pagination, action/date filters. Permission: ADMIN/OWNER
4. **API: `/api/tenant/audit-logs/download`** (GET): Export endpoint for CSV/JSONL. Require date range filter (max 90 days), row limit (100,000 rows), rate limit (1 download/min/admin)
5. **API: `/api/tenant/breakglass`** (POST): Create grant — validate reason, check permissions, create grant, send notification, record audit log
6. **API: `/api/tenant/breakglass`** (GET): List grants for current tenant
7. **API: `/api/tenant/breakglass/[id]`** (DELETE): Revoke grant, record audit log
8. **API: `/api/tenant/breakglass/[grantId]/logs`** (GET): Proxy personal log query for target user (only if grant is active and not expired)
9. **UI: `TenantAuditLogCard`**: Tenant audit log tab with filters, export, log list
10. **UI: `BreakGlassDialog`**: Grant request form with user selector, reason, incident ref
11. **UI: `BreakGlassGrantList`**: Grant management table with status, revoke, view actions
12. **UI: `BreakGlassPersonalLogViewer`**: Read-only personal log viewer with grant context banner
13. **UI: Tenant settings page**: Add audit log tab (5th tab)
14. **i18n**: Add all new translation keys to `messages/en.json` and `messages/ja.json`
15. **Sidebar navigation**: Update sidebar to highlight audit log tab when active
16. **Tests**: Unit tests for API routes, integration tests for grant lifecycle
17. **Build verification**: Run `npx vitest run` and `npx next build`

## Testing Strategy

### Unit Tests
- API route handlers: permission checks, grant creation/revocation, log filtering
- Validation: reason min/max length, incidentRef max length, grant expiry, duplicate active grants
- Edge cases: expired grants denied access, revoked grants denied access, deactivated target denied
- Constants synchronization: new actions in `AUDIT_ACTION_VALUES`, new group in `AUDIT_ACTION_GROUPS_TENANT`
- Notification type synchronization: new `PERSONAL_LOG_ACCESSED` in `NOTIFICATION_TYPE`
- Rate limiting: test both Redis and in-memory fallback paths for 5/hour limit
- Zod validation schemas for breakglass request body

### Integration Tests
- Full Break-Glass lifecycle: create grant → view logs → grant expires → access denied
- Duplicate active grant rejection: POST with existing active grant returns 409
- Notification delivery on grant creation
- Audit trail completeness: all Break-Glass actions recorded with correct scope (TENANT) and userId (admin)
- RLS enforcement: admin from tenant A cannot access grants from tenant B
- assertOrigin validation: POST without valid origin returns 403

### Component Tests
- `BreakGlassPersonalLogViewer`: encrypted entry names display "[Encrypted]" fallback
- `BreakGlassGrantList`: expired/revoked grants show correct badges
- `BreakGlassDialog`: reason field enforces minimum length

### Manual Testing
- Verify tenant admin can see TENANT + TEAM scoped logs
- Verify Break-Glass dialog enforces reason requirement
- Verify target user receives notification
- Verify expired grants block log access
- Verify encrypted entry names show "[Encrypted]" in Break-Glass viewer

### Build Verification
- Run `npx next build` after each UI component step (Steps 9-13), not just at the final step
- This catches "use client" directive omissions and Web Crypto API SSR bundling issues early

## Considerations & Constraints

1. **Encrypted entry names**: Admin cannot decrypt personal entry names (no access to user's vault key). Display "[Encrypted]" placeholder. This is by design — the admin sees actions and metadata but not password titles.
2. **Single active grant per target**: Allow only one active (non-expired, non-revoked) grant per requester-target pair to prevent grant stacking.
3. **24-hour fixed expiry**: No extension mechanism — must create a new grant with a new reason. This ensures fresh justification for continued access.
4. **No self-access**: Admin cannot create a Break-Glass grant targeting themselves (the personal audit log page already serves this purpose).
5. **Grant history retention**: Grants are never deleted — they transition to expired/revoked state for audit trail.
6. **Tab layout**: Moving from 4 to 5 tabs; if this feels crowded, can consider grouping SCIM + Directory Sync under a "Provisioning" tab to keep it at 5.
7. **Out of scope**: Approval workflow (second admin approval) — can be added later for larger organizations.
8. **Out of scope**: Email notification — using in-app notification only for now.
9. **CSRF protection**: Next.js API routes use standard session-based CSRF protection via Auth.js. No additional CSRF token is needed for same-origin API calls with session cookies.
10. **Responsive tab layout**: The 5-tab layout will use `grid-cols-2 md:grid-cols-5` to avoid overflow on mobile (2-column wrapping on small screens).
11. **Download vs GET asymmetry**: The 90-day date range limit and 100k row cap apply only to the download endpoint, not to the paginated GET endpoint. This is intentional — GET uses cursor-based pagination with a small page size (max 100), so resource exhaustion is not a concern.
