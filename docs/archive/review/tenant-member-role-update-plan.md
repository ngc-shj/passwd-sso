# Plan: Tenant Member Role Update

## Objective

Add a role update feature for tenant members in the UI, following the same pattern used for team member role updates. Currently, tenant members can only be listed and have their vaults reset — there is no way to change a member's role (OWNER/ADMIN/MEMBER) from the UI.

## Requirements

### Functional Requirements

1. **UI**: Add a `Select` dropdown to change tenant member roles (ADMIN/MEMBER) in `TenantMembersCard`, matching the team settings pattern. For ownership transfer, include OWNER in the Select options and show an AlertDialog confirmation when selected.
2. **API**: Create `PUT /api/tenant/members/[userId]` endpoint to update a member's role
3. **Authorization**: Enforce role hierarchy — only OWNER can change roles; ADMIN cannot change other ADMIN/OWNER roles
4. **Ownership Transfer**: OWNER can transfer ownership to another member (promotes target to OWNER, demotes self to ADMIN)
5. **SCIM-managed member protection**: Block role changes for SCIM-managed members to prevent directory sync conflicts
6. **Audit Logging**: Log role changes with `TENANT_ROLE_UPDATE` action, recording both previous and new role in metadata
7. **i18n**: Add translation keys for role change success/failure messages, referenced from UI code

### Non-Functional Requirements

1. Follow existing codebase patterns (team member role update as reference)
2. All changes must pass `npx vitest run` and `npx next build`

## Technical Approach

### Architecture Decisions

- **No new permission**: Reuse `TENANT_PERMISSION.MEMBER_MANAGE` for role changes (consistent with how this permission gates all member management)
- **OWNER-only role changes**: Unlike teams where ADMIN can change lower roles, tenant role changes are restricted to OWNER only, because OWNER and ADMIN share identical permissions — allowing ADMIN to change roles would let them demote other ADMINs with no meaningful hierarchy distinction. The API enforces this with an explicit `actor.role !== "OWNER"` check immediately after the permission check.
- **New audit action**: Add `TENANT_ROLE_UPDATE` to the Prisma `AuditAction` enum and audit constants
- **New audit target type**: Add `TENANT_MEMBER` to `AUDIT_TARGET_TYPE`
- **Validation schema**: Create `updateTenantMemberRoleSchema` with TenantRole values (OWNER, ADMIN, MEMBER)
- **API path**: Add `tenantMemberById(userId)` helper → `/api/tenant/members/${userId}`
- **No nested transactions**: Ownership transfer follows the team pattern — execute sequential updates inside `withTenantRls()` which already provides an atomic RLS transaction context. Do NOT nest `prisma.$transaction()` inside `withTenantRls()` as Prisma does not support nested interactive transactions. Re-verify the actor's OWNER status inside the RLS scope before proceeding.
- **SCIM guard**: API rejects role changes for members with `scimManaged: true`, returning 409 Conflict
- **Explicit tenant isolation**: Target member lookup uses both `withTenantRls(prisma, actor.tenantId, ...)` AND explicitly filters `where: { userId, tenantId: actor.tenantId }` for defense-in-depth, matching the team pattern of verifying `target.teamId !== teamId` after lookup.

### Key Patterns (from team member role update)

1. UI: `Select` component with `onValueChange` triggers `handleChangeRole(userId, newRole)`
2. API: PUT handler with auth check → permission check → OWNER-only check → self-change prevention → target lookup (with tenantId filter) → SCIM guard → role hierarchy check → update → audit log
3. Ownership transfer: Sequential updates inside RLS scope promoting target and demoting current owner

## Implementation Steps

### Step 1: Prisma Schema — Add `TENANT_ROLE_UPDATE` to `AuditAction` enum

- File: `prisma/schema.prisma`
- Add `TENANT_ROLE_UPDATE` to the `AuditAction` enum

### Step 2: Run Prisma migration

- `npm run db:migrate` with migration name `add-tenant-role-update-audit-action`

### Step 3: Constants — Add audit action and target type

- File: `src/lib/constants/audit.ts`
  - Add `TENANT_ROLE_UPDATE: "TENANT_ROLE_UPDATE"` to `AUDIT_ACTION`
  - Add to `AUDIT_ACTION_VALUES` array
  - Add to `AUDIT_ACTION_GROUPS_TENANT` under `ADMIN` group (alongside other tenant admin actions)
- File: `src/lib/constants/audit-target.ts`
  - Add `TENANT_MEMBER: "TenantMember"` to `AUDIT_TARGET_TYPE`
- File: `src/lib/constants/audit.test.ts`
  - Add `AUDIT_ACTION_GROUPS_TENANT` to the existing test that validates action group entries, ensuring tenant group integrity is verified

### Step 4: Constants — Add tenant role constants

- File: `src/lib/constants/tenant-role.ts` (new file)
  - Define `TENANT_ROLE` constant object (OWNER, ADMIN, MEMBER) with `satisfies Record<TenantRole, TenantRole>`
  - Define `TENANT_ROLE_VALUES` array for Zod validation
- File: `src/lib/constants/index.ts`
  - Export new tenant role constants

### Step 5: Validation — Add `updateTenantMemberRoleSchema`

- File: `src/lib/validations.ts`
  - Add `TENANT_ROLE_VALUES` import
  - Add `updateTenantMemberRoleSchema = z.object({ role: z.enum(TENANT_ROLE_VALUES) })`
  - Add type export `UpdateTenantMemberRoleInput`

### Step 6: API Path — Add tenant member by ID helper

- File: `src/lib/constants/api-path.ts`
  - Add `tenantMemberById(userId)` → `/api/tenant/members/${userId}`

### Step 7: API — Create `PUT /api/tenant/members/[userId]/route.ts`

- File: `src/app/api/tenant/members/[userId]/route.ts` (new file)
- **IMPORTANT**: Self-change prevention (step 4) MUST be before ownership transfer logic (step 8) to prevent OWNER from demoting themselves and leaving the tenant without an OWNER.
- Logic:
  1. Auth check (session required)
  2. `requireTenantPermission(session.user.id, MEMBER_MANAGE)` — gates access
  3. **Explicit OWNER-only check**: if `actor.role !== "OWNER"`, return 403 — prevents ADMIN from reaching role change logic
  4. **Self-change prevention**: if `params.userId === session.user.id`, return 400 — MUST be before ownership transfer to prevent OWNER-less tenant
  5. Validate request body with `updateTenantMemberRoleSchema`
  6. Look up target TenantMember inside `withTenantRls(prisma, actor.tenantId, ...)` with explicit `where: { userId: params.userId, tenantId: actor.tenantId, deactivatedAt: null }`
  7. **SCIM guard**: if `target.scimManaged === true`, return 409 Conflict with error message
  8. **Ownership transfer case**: if new role is OWNER, inside `withTenantRls`:
     - Re-verify actor is still OWNER (findFirst inside RLS scope)
     - Demote actor to ADMIN (first, to avoid transient dual-OWNER state)
     - Promote target to OWNER
     - (No nested $transaction — RLS scope provides atomicity)
  9. **OWNER protection**: if target.role is OWNER (and not transferring), return 403
  10. Update role in DB inside `withTenantRls`
  11. Log audit with `TENANT_ROLE_UPDATE`, metadata: `{ previousRole, newRole, transfer?: true }`
  12. Return updated member data: `{ id, userId, role, name, email, image }`

### Step 7b: API Unit Tests

- File: `src/app/api/tenant/members/[userId]/route.test.ts` (new file)
- Follow existing patterns from `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts` and `src/app/api/tenant/members/route.test.ts`
- Test cases:
  - Unauthenticated → 401
  - No MEMBER_MANAGE permission → 403
  - ADMIN calls endpoint → 403 (OWNER-only check)
  - Self-change → 400
  - Target not found → 404
  - SCIM-managed member → 409
  - Invalid role value → 400
  - Invalid JSON → 400
  - MEMBER → ADMIN success → 200
  - ADMIN → MEMBER success → 200
  - Ownership transfer → target becomes OWNER, actor becomes ADMIN
  - Change OWNER's role (not transfer) → 403
  - Audit log records previousRole and newRole

### Step 8: i18n — Add translation keys

- Files: `messages/ja/TenantAdmin.json`, `messages/en/TenantAdmin.json`
- Add keys (all referenced in UI code in Step 9):
  - `roleChanged`: "ロールを変更しました。" / "Role has been changed."
  - `roleChangeFailed`: "ロールの変更に失敗しました。" / "Failed to change role."
  - `scimManagedRoleError`: "SCIMで管理されているメンバーのロールは変更できません。" / "Cannot change role of SCIM-managed member."
  - `transferOwnership`: "オーナー権限の移譲" / "Transfer Ownership"
  - `transferOwnershipDesc`: "オーナー権限を別のメンバーに移譲します。あなたのロールは管理者に変更されます。" / "Transfer ownership to another member. Your role will be changed to Admin."
  - `transferOwnershipConfirm`: "移譲する" / "Transfer"
  - `transferOwnershipSuccess`: "オーナー権限を移譲しました。" / "Ownership transferred successfully."

### Step 9: Update API response to include `scimManaged`

- File: `src/app/api/tenant/members/route.ts`
  - Add `scimManaged` to the select and response mapping
- File: `src/components/settings/tenant-members-card.tsx`
  - Add `scimManaged: boolean` to `TenantMember` interface

### Step 10: UI — Add role change Select to `TenantMembersCard`

- File: `src/components/settings/tenant-members-card.tsx`
- Changes:
  1. Import `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from shadcn/ui
  2. Import `AlertDialog` components for ownership transfer confirmation
  3. Import `apiPath` from constants, `toast` from sonner
  4. Add `handleChangeRole(userId, newRole)` function:
     - If newRole is OWNER, show AlertDialog confirmation first
     - PUT to `apiPath.tenantMemberById(userId)` with `{ role: newRole }`
     - On success: show `t("roleChanged")` toast (or `t("transferOwnershipSuccess")` for transfer)
     - On 409 error: show `t("scimManagedRoleError")` toast
     - On other error: show `t("roleChangeFailed")` toast
     - Call `fetchMembers()` to refresh list
  5. For each member row where `myRole === "OWNER"` and target is not OWNER and not self and not deactivated:
     - Replace static `Badge` with `Select` dropdown offering ADMIN/MEMBER options
     - Disable Select for SCIM-managed members with tooltip explaining why
  6. For OWNER role members, self, and deactivated: display static Badge (no dropdown)

## Testing Strategy

1. **Build verification**: `npx next build` must pass
2. **Unit tests**: New test file `src/app/api/tenant/members/[userId]/route.test.ts` with comprehensive test cases (see Step 7b)
3. **Existing tests**: `npx vitest run` must pass (no regressions), including updated `audit.test.ts`
4. **Manual testing scenarios**:
   - OWNER changes ADMIN → MEMBER (success)
   - OWNER changes MEMBER → ADMIN (success)
   - OWNER transfers ownership via Select dropdown → AlertDialog → confirm (success, OWNER becomes ADMIN)
   - ADMIN cannot see role select (only Badge displayed)
   - Cannot change own role (error)
   - Cannot change deactivated member's role (not found)
   - Cannot change SCIM-managed member's role (409 error, Select disabled)
   - Concurrent ownership transfers handled safely

## Considerations & Constraints

1. **OWNER-only restriction**: Since OWNER and ADMIN share identical permissions in the tenant model, only OWNER should change roles to prevent ADMINs from demoting each other
2. **SCIM protection**: Role changes for SCIM-managed members are blocked at the API level to prevent conflicts with directory sync
3. **No nested transactions**: Ownership transfer uses sequential updates inside `withTenantRls()` RLS scope (which is already a transaction), NOT a nested `prisma.$transaction()` call
4. **Audit completeness**: Both previous and new roles are recorded in audit metadata for forensic traceability
5. **Tenant isolation**: Target lookup uses both RLS scope AND explicit tenantId filter for defense-in-depth
6. **Session invalidation**: Role changes do not require session invalidation. API-side permission checks re-read the role from DB on every request. Client-side role cache (`useTenantRole` hook) refreshes on next page load or fetchMembers() call.
7. **Self-change ordering**: Self-change prevention check is placed before ownership transfer logic to prevent scenarios where OWNER could leave the tenant without an owner
8. **Prisma migration**: Adding a new enum value to `AuditAction` requires a database migration
9. **Out of scope**: Member invitation, removal, deactivation features, and OpenAPI spec updates are not part of this change
