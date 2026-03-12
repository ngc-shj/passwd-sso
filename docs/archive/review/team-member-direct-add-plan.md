# Plan: Team Member Direct Add

## Objective

Add the ability for team admins (ADMIN/OWNER) to search for existing tenant members and directly add them to the team, without going through the email invitation flow.

Currently, the only way to add team members is via email invitation (create invitation → share token URL → invitee accepts). This feature adds a second method: searching tenant members by name/email and adding them immediately.

## Requirements

### Functional Requirements

1. **Tenant member search API**: ADMIN/OWNER can search active tenant members who are NOT already active members of the team AND do NOT have a non-expired pending invitation. Search by name or email (partial match, case-insensitive). Limit results to 10.
2. **Direct add API**: ADMIN/OWNER can add a tenant member to the team with a specified role (ADMIN, MEMBER, VIEWER — OWNER is explicitly forbidden via `TEAM_INVITE_ROLE_VALUES`). The target user must be an active tenant member and not already an active team member.
3. **UI**: Add an "Add from tenant" section in the team settings Members tab (visible to ADMIN+). Includes a search input with dropdown results, role selector, and add button.
4. **Audit logging**: Log `TEAM_MEMBER_ADD` action (distinct from `TEAM_MEMBER_INVITE`) with target user info. Audit log is fire-and-forget (consistent with existing patterns), not transactional. `targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER`, `targetId: TeamMember.id`.
5. **E2E encryption consideration**: New member is added with `keyDistributed: false`. Existing key distribution flow handles this (admin distributes team key when online).

### Non-Functional Requirements

1. Search must be debounced (300ms) on the client to avoid excessive API calls. Previous in-flight requests must be aborted via `AbortController`.
2. API must enforce tenant scoping — only search within the team's tenant.
3. SCIM-managed deactivated team members cannot be re-added (must go through IdP). The `scimManaged` boolean field on `TeamMember` is used for this check.

## Design Decisions

1. **Role hierarchy on add**: ADMIN can add a user as ADMIN (same level). This is consistent with the existing invite flow, which also does not enforce `isRoleAbove` for the requested role — it only uses `TEAM_INVITE_ROLE_VALUES` to exclude OWNER. Changing this would break invite/add parity.
2. **SCIM scope**: SCIM manages tenant membership (`TenantMember.scimManaged`) and team group mappings (`ScimGroupMapping` → `TeamMember.scimManaged`) independently. A SCIM-provisioned tenant member CAN be manually added to a team — SCIM only blocks re-activation of SCIM-created team memberships. This is by design.
3. **Audit atomicity**: `logAudit()` is fire-and-forget (existing pattern throughout the codebase). The TeamMember creation/reactivation and TeamMemberKey cleanup run inside `withTeamTenantRls` which internally wraps in a Prisma `$transaction`. Audit log failure does not roll back member creation.
4. **TeamMemberKey cleanup asymmetry**: The direct add flow deletes stale `TeamMemberKey` records on reactivation. The existing `invitations/accept` flow does NOT do this (existing gap). This asymmetry is intentional for this PR — fixing `accept/route.ts` is a separate concern to avoid regression risk. See Considerations #8.
5. **Transaction semantics within RLS context**: `withTeamTenantRls` already wraps the callback in `prisma.$transaction(async tx => ...)`. Any `prisma.$transaction([...])` calls inside this context run as `Promise.all` (not nested savepoints). This is the same pattern used by existing handlers (e.g., `accept/route.ts:133`, `members/[memberId]/route.ts:214`).

## Technical Approach

### Architecture

- Reuse existing `TEAM_PERMISSION.MEMBER_INVITE` permission for the add flow. This permission is only granted to ADMIN and OWNER roles (see `ROLE_PERMISSIONS` in `src/lib/team-auth.ts`).
- New Prisma enum value `TEAM_MEMBER_ADD` for audit differentiation.
- Two new API routes under the existing `/api/teams/[teamId]/members/` path.
- UI component integrated into the existing team settings page (no new page needed).

### Data Flow

```
[Admin UI] → GET /api/teams/:teamId/members/search?q=xxx
           → Returns matching tenant members (not already in team, no non-expired pending invite)

[Admin UI] → POST /api/teams/:teamId/members
           → Creates TeamMember record directly (no invitation)
           → Logs TEAM_MEMBER_ADD audit event (fire-and-forget)
           → Returns new member info
```

## Implementation Steps

### Step 1: Prisma Schema — Add TEAM_MEMBER_ADD Audit Action

File: `prisma/schema.prisma`

- Add `TEAM_MEMBER_ADD` to the `AuditAction` enum (before `TEAM_MEMBER_INVITE`).
- Run `npx prisma generate` to update the client.
- Migration: `npx prisma migrate dev --name add-team-member-add-audit-action`

### Step 2: Audit Constants — Add TEAM_MEMBER_ADD

File: `src/lib/constants/audit.ts`

- Add `TEAM_MEMBER_ADD: "TEAM_MEMBER_ADD"` to `AUDIT_ACTION` object (after `ATTACHMENT_DELETE`, before `TEAM_MEMBER_INVITE`).
- Add to `AUDIT_ACTION_VALUES` array (after `AUDIT_ACTION.ATTACHMENT_DELETE`).
- Add to `AUDIT_ACTION_GROUPS_TEAM[TEAM]` array only (NOT to `AUDIT_ACTION_GROUPS_PERSONAL` — this is a team-scoped action).

### Step 3: API Path Helpers

File: `src/lib/constants/api-path.ts`

- Add `teamMembersSearch` helper: `` (teamId: string) => `${API_PATH.TEAMS}/${teamId}/members/search` ``

File: `src/lib/constants/api-path.test.ts`

- Add test assertion to existing `"builds team and emergency paths"` block.

### Step 4: Validation Schema

File: `src/lib/validations.ts`

- Add `addMemberSchema` using `TEAM_INVITE_ROLE_VALUES` (which already excludes OWNER):
  ```ts
  export const addMemberSchema = z.object({
    userId: z.string().cuid(),
    role: z.enum(TEAM_INVITE_ROLE_VALUES).default(TEAM_ROLE.MEMBER),
  });
  ```
- Add `AddMemberInput` type export.

Note: Project uses `@default(cuid())` (v1) throughout. `z.string().cuid()` is consistent with existing schemas.

### Step 5: Search API Route

File: `src/app/api/teams/[teamId]/members/search/route.ts` (new file)

- `GET /api/teams/[teamId]/members/search?q=<query>`
- Auth: require session
- Permission: `TEAM_PERMISSION.MEMBER_INVITE` (ADMIN/OWNER only)
- Validate: `q` query param, `z.string().min(1).max(100)` — reject empty strings with 400
- Logic (inside `withTeamTenantRls` callback):
  1. Fetch team record to get `tenantId`: `prisma.team.findUnique({ where: { id: teamId }, select: { tenantId: true } })`
  2. Get list of existing active `TeamMember` userIds for this team
  3. Get non-expired PENDING `TeamInvitation` emails for this team (where `expiresAt > new Date()`), then resolve those emails to userIds via `User.findMany({ where: { email: { in: pendingEmails } } })` — this is needed because `TeamInvitation` stores `email`, not `userId`
  4. Combine exclusion sets (active member userIds + pending invitee userIds)
  5. Query `User` records where:
     - `tenantId` equals team's `tenantId` (explicit filter)
     - `id` NOT in exclusion set
     - `name` OR `email` contains `q` (case-insensitive via `mode: "insensitive"`)
     - Has active `TenantMember` record (via relation filter: `tenantMemberships: { some: { tenantId, deactivatedAt: null } }`)
  6. Limit to 10 results, order by `name` ascending
  7. Return `[{ userId, name, email, image }]`

### Step 6: Direct Add API Route

File: `src/app/api/teams/[teamId]/members/route.ts` (add POST handler to existing file)

- `POST /api/teams/[teamId]/members`
- Auth: require session
- Permission: `TEAM_PERMISSION.MEMBER_INVITE` (ADMIN/OWNER only)
- Validate body with `addMemberSchema`
- Logic (inside `withTeamTenantRls` callback — already within a transaction):
  1. Fetch team to get `tenantId`: `prisma.team.findUnique(...)`
  2. Verify target user exists and is an active tenant member:
     - `User` with matching `id` and `tenantId` must exist
     - `TenantMember` with `tenantId` + `userId` and `deactivatedAt: null` must exist
     - → 404 if either check fails
  3. Check existing `TeamMember` record (query by `teamId` + `userId`):
     a. Active member (`deactivatedAt: null`) → 409 `ALREADY_A_MEMBER`
     b. Deactivated + `scimManaged: true` → 409 `SCIM_MANAGED_MEMBER`
     c. Deactivated + `scimManaged: false` → reactivate:
        - `prisma.$transaction([...])` (runs as Promise.all inside RLS context):
          - `prisma.teamMemberKey.deleteMany({ where: { teamId, userId } })` — delete stale encryption keys
          - `prisma.teamMember.update(...)`: `deactivatedAt: null`, `role`, `keyDistributed: false`, `scimManaged: false`
  4. If no existing record → `prisma.teamMember.create(...)` with `keyDistributed: false`, `tenantId: team.tenantId`
  5. After `withTeamTenantRls` callback returns: `logAudit()` fire-and-forget with:
     - `scope: AUDIT_SCOPE.TEAM`
     - `action: AUDIT_ACTION.TEAM_MEMBER_ADD`
     - `targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER`
     - `targetId: member.id` (the TeamMember record id)
     - `metadata: { userId, role, reactivated: boolean }`
  6. Return created/reactivated member (201)

Race condition handling: The `@@unique([teamId, userId])` constraint on `TeamMember` prevents duplicate rows. A Prisma unique constraint violation is caught and returns 409.

### Step 7: i18n Translation Keys

Files: `messages/ja/Team.json`, `messages/en/Team.json`

Add keys:
- `addFromTenant`: "テナントから追加" / "Add from Tenant"
- `searchTenantMembers`: "テナントメンバーを検索..." / "Search tenant members..."
- `addButton`: "追加" / "Add"
- `memberAdded`: "メンバーを追加しました" / "Member added"
- `addMemberFailed`: "メンバーの追加に失敗しました" / "Failed to add member"
- `noTenantMembersFound`: "該当するメンバーが見つかりません" / "No matching members found"

Files: `messages/ja/AuditLog.json`, `messages/en/AuditLog.json`

Add keys:
- `TEAM_MEMBER_ADD`: "メンバー追加" / "Added member"

### Step 8: Team Settings UI Update

File: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`

- Add state for: `addSearch`, `addRole`, `adding`, `searchResults`, `searchLoading`
- Add `handleSearchTenantMembers` function with 300ms debounce (via `useEffect` + `setTimeout`), using `AbortController` to cancel previous in-flight requests
- Add `handleAddMember` function that calls `POST /api/teams/:teamId/members`
- Add new Card section between the existing "Members" card and the "Invite Member" card (visible to ADMIN+):
  - Title: "Add from Tenant" with `UserPlus` icon
  - Search input with results dropdown
  - Each result shows avatar, name, email, and "Add" button with role selector
- After successful add, call `fetchAll()` to refresh members list and clear search

## Testing Strategy

### Automated Tests

- API path helper test: add `teamMembersSearch` assertion to existing `"builds team and emergency paths"` block in `api-path.test.ts`.

### Manual Testing

1. As ADMIN, search for tenant members → verify results exclude existing team members and non-expired pending invitees
2. Search with an expired invitation → verify user appears in results
3. Add a member → verify they appear in the members list with correct role and `keyDistributed: false`
4. Try to add an already-added member → verify 409 error
5. As MEMBER/VIEWER, verify search/add section is not visible
6. Verify key distribution pending state for newly added member
7. Test concurrent add of same user by two admins → verify no duplicate, one gets 409
8. Re-add a previously removed (deactivated, non-SCIM) member → verify reactivation, old TeamMemberKey deleted, scimManaged reset
9. Try to re-add a SCIM-managed deactivated member → verify 409
10. Search with special characters (%, _) → verify no unexpected behavior

### Build Verification

- `npx vitest run` — all existing tests must pass
- `npx next build` — production build must succeed

## Considerations & Constraints

1. **Cross-tenant**: The search only returns members of the team's own tenant. Cross-tenant member addition is not in scope (that requires the invitation flow).
2. **Key distribution**: Direct-added members still need key distribution from an admin. The `keyDistributed: false` flag and existing auto-distribution mechanism handle this. Re-activated members also have `keyDistributed` reset to `false` and old `TeamMemberKey` records deleted to ensure fresh key distribution.
3. **SCIM-managed members**: Deactivated SCIM-managed team members cannot be re-added manually. They must be re-activated through the IdP. The `scimManaged` boolean on `TeamMember` is checked explicitly. On manual reactivation, `scimManaged` is reset to `false`.
4. **Rate limiting**: No dedicated rate limiting for the search endpoint — the existing global rate limiter applies.
5. **Privacy**: Tenant member search exposes names/emails of tenant members to team admins. This is acceptable because team admins are typically tenant ADMIN+ anyway, and the search is scoped to the same tenant.
6. **Atomicity**: The `withTeamTenantRls` callback runs inside a Prisma transaction. `logAudit()` is called outside the callback as fire-and-forget (consistent with existing codebase patterns). Any `prisma.$transaction([...])` inside the RLS context runs as `Promise.all` (not nested savepoints) — same as existing handlers.
7. **Unique constraint**: The `@@unique([teamId, userId])` on `TeamMember` prevents duplicate member rows even under concurrent requests.
8. **Known gap — accept/route.ts**: The existing invitation accept flow (`invitations/accept/route.ts`) does NOT delete `TeamMemberKey` records on reactivation. This is a pre-existing gap that should be addressed in a separate PR to avoid regression risk. The direct add flow in this PR does perform this cleanup.
9. **Known gap — invitation expiry check**: The existing invitation creation flow (`invitations/route.ts`) does NOT check `expiresAt` when detecting duplicate pending invitations. Expired PENDING invitations block new invitations. This is a pre-existing issue outside this PR's scope.
