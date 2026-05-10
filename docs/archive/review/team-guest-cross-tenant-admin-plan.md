# Plan: Team Guest Cross-Tenant Admin

Plan name: `team-guest-cross-tenant-admin`  
Branch proposal: `fix/team-guest-cross-tenant-admin`  
Save path: `docs/archive/review/team-guest-cross-tenant-admin-plan.md`

## Project Context

- Type: `web app`
- Test infrastructure: `unit + integration`
- Scope: team membership management, guest-member crypto flows, sidebar/admin navigation, cross-tenant display behavior

## Objective

Make guest membership in another tenant behave correctly across the team-admin experience.

This plan covers:

- listing and updating guest team members whose `users.tenant_id` differs from the team tenant
- completing key-distribution and key-rotation flows for those guest members
- preventing duplicate invitation flows caused by team-tenant RLS hiding existing guest users
- aligning admin and vault UI so the current tenant/team context is visible and navigation follows the selected vault scope

## Requirements

### Functional

1. Team members list and team member update responses must include guest members even when their `users` row is not visible under team-tenant RLS.
2. Team key distribution and key rotation must resolve guest members' `ecdhPublicKey` correctly.
3. Team invitation creation must detect an already-added guest member by email and reject re-invite with `ALREADY_A_MEMBER`.
4. Team/admin scope selectors must show the guest team's tenant name consistently with the vault selector.
5. Team members list must label "other tenant" relative to the viewer's tenant, not the team tenant.
6. "Add from tenant" must clarify that the searchable tenant is the team's tenant, not the guest admin's home tenant.
7. Sidebar "Admin Console" navigation must route to the selected team admin page when a team vault is active, and to tenant admin when personal vault is active.

### Non-functional

1. RLS bypass use must stay narrowly scoped to cross-tenant lookup surfaces only.
2. Existing permission checks, route structure, and tenant/team boundaries must remain unchanged.
3. Shared display logic must be centralized so future team-member screens do not reintroduce the same bug.
4. Tests must cover both cross-tenant data access and UI context rendering.

## Technical Approach

### Design Summary

- Keep team-scoped rows under `withTeamTenantRls(...)`.
- For guest-sensitive related data stored on `users` or home-tenant `tenant_members`, hydrate that data separately through `withBypassRls(..., BYPASS_PURPOSE.CROSS_TENANT_LOOKUP)`.
- Centralize team-member display hydration into a reusable helper so list/update flows share one contract.
- Keep UI comparisons explicit:
  - home tenant display: the member's actual home tenant
  - "other tenant" badge: relative to the current viewer tenant
  - "Add from tenant" note: explicit team-tenant clarification when viewer tenant differs
- Route admin-console entry based on `vaultContext`, not on generic `/admin` redirect behavior.

### Affected Areas

- Team members API and display helper
- Team confirm-key and rotate-key data routes
- Team invitations create route
- Admin scope selector and vault selector presentation
- Shared member info component
- Sidebar settings/admin link

## Contracts

### C1. Cross-tenant team-member display hydration

- Subject: Team-member responses expose a stable display shape even when the member's `users` row is outside the team tenant.
- Function/module signatures:
  - `buildTeamMemberDisplayItems(args): Promise<TeamMemberDisplayItem[]>`
  - Inputs:
    - team-member rows with `userId`, `role`, `keyDistributed`, `deactivatedAt`, and team-scoped metadata
  - Output item fields:
    - `userId`
    - `name`
    - `email`
    - `image`
    - `tenantName`
    - `role`
    - `keyDistributed`
    - `deactivatedAt`
- Invariants:
  - Team-member base rows are fetched under team RLS.
  - User profile and home-tenant display info are hydrated with bypass only after the team-member set is known.
  - Members missing a visible/hydratable user profile are excluded from display output.
  - Display helper is the single source of truth for cross-tenant member presentation.
- Forbidden patterns:
  - `pattern: teamMember\\.(findMany|findUnique|update)\\([\\s\\S]*include:\\s*\\{[\\s\\S]*user:\\s*\\{ — reason: direct user join under team RLS drops guest users`
  - `pattern: include:\\s*\\{[\\s\\S]*tenantMemberships?: — reason: home-tenant metadata must not be joined under team RLS for guest display`
- Acceptance criteria:
  - Guest members appear in the members list.
  - Guest members remain present in update responses after role change or ownership transfer.
  - Displayed `tenantName` reflects the member's home tenant.
- Consumer-flow walkthrough:
  - `src/app/api/teams/[teamId]/members/route.ts` reads `{ userId, name, email, image, tenantName, role, keyDistributed, deactivatedAt }` and serializes them to the members list page, which uses `tenantName` for cross-tenant labeling and profile identity fields for row rendering.
  - `src/app/api/teams/[teamId]/members/[memberId]/route.ts` reads the same display fields after mutation and returns them to UI mutation handlers so the updated row can be re-rendered without a follow-up fetch.

### C2. Cross-tenant guest crypto-key lookup

- Subject: Team key distribution routes resolve guest members' public keys outside team-tenant RLS while keeping team membership checks scoped.
- Function/module signatures:
  - `POST /api/teams/[teamId]/members/[memberId]/confirm-key`
  - `GET /api/teams/[teamId]/rotate-key/data`
  - Both routes consume `userId` from team-scoped membership/key rows and resolve `users.ecdhPublicKey` separately.
- Invariants:
  - Team membership and member-key rows stay under `withTeamTenantRls(...)`.
  - `users.ecdhPublicKey` is loaded by explicit `userId` lookup through bypass.
  - Missing guest public key yields the same route-level failure mode as a missing in-tenant public key.
- Forbidden patterns:
  - `pattern: ecdhPublicKey[\\s\\S]*include:\\s*\\{[\\s\\S]*user:\\s*\\{ — reason: guest public-key lookup cannot depend on user join inside team RLS`
  - `pattern: teamMemberKey\\.findMany\\([\\s\\S]*user:\\s*\\{[\\s\\S]*ecdhPublicKey — reason: rotate-key data must bypass user lookup explicitly`
- Acceptance criteria:
  - Guest members can complete initial key distribution.
  - Guest members are included in rotate-key payloads when they need new encrypted team keys.
- Consumer-flow walkthrough:
  - `src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts` reads `memberId -> userId -> ecdhPublicKey` and uses the public key to validate or complete key distribution for the selected team member.
  - `src/app/api/teams/[teamId]/rotate-key/data/route.ts` reads `{ userId, teamMemberKey rows }` and uses `ecdhPublicKey` to build the per-member encryption payload for team-key rotation consumers.

### C3. Guest existing-user lookup during invitation create

- Subject: Invitation creation must detect existing guest users already added to the team.
- Function/module signatures:
  - `POST /api/teams/[teamId]/invitations`
  - Lookup path:
    - email -> existing user (bypass)
    - existing user -> team member state (team RLS)
- Invariants:
  - Email lookup for existing user is not limited by team-tenant RLS.
  - Membership existence and invitation uniqueness checks remain team-scoped.
  - Existing active guest member returns `ALREADY_A_MEMBER` instead of creating a duplicate invitation.
- Forbidden patterns:
  - `pattern: withTeamTenantRls\\([\\s\\S]*prisma\\.user\\.findUnique\\(\\{[\\s\\S]*email — reason: guest existing-user lookup must not rely on team-tenant visibility`
- Acceptance criteria:
  - Re-inviting an already-added guest by email is rejected.
  - In-tenant users continue to follow the same behavior.
- Consumer-flow walkthrough:
  - `src/components/team/members/team-invite-by-email-section.tsx` reads route errors and uses `ALREADY_A_MEMBER` to keep the user in the invite dialog instead of issuing a new invite token.

### C4. Cross-tenant team/admin UI context alignment

- Subject: Team and admin UI surfaces render tenant context and navigation according to the active viewer/team scope.
- Function/module signatures:
  - `TeamScopeOption({ name, tenantName, isCrossTenant })`
  - `MemberInfo({ name, email, image, tenantName, viewerTenantName?, teamTenantName? })`
  - `SettingsNavSection({ adminConsoleHref, ... })`
- Invariants:
  - Team scope selectors show guest tenant name when `isCrossTenant` is true.
  - Member "other tenant" labeling compares member home tenant against `viewerTenantName` when provided.
  - Sidebar admin console link depends on active vault context:
    - team vault -> `/admin/teams/{teamId}/general`
    - personal vault -> `/admin/tenant/members`
  - "Add from tenant" note appears only when viewer tenant differs from the team tenant.
- Forbidden patterns:
  - `pattern: href=\"/admin\" — reason: sidebar admin entry must resolve explicit destination by vault scope`
  - `pattern: tenantName !== teamTenantName — reason: member cross-tenant badge must compare against viewer tenant in team-admin screens`
- Acceptance criteria:
  - Guest admin sees tenant name in admin scope selector.
  - Guest admin sees their own member row compared against their home tenant, not the team tenant.
  - "Add from tenant" note explains the searchable tenant to guest admins.
  - Sidebar admin-console click lands on team admin when a team vault is selected.
- Consumer-flow walkthrough:
  - `src/components/admin/admin-scope-selector.tsx` reads `{ team.name, tenantName, isCrossTenant }` and renders the visible current team/admin scope, using `tenantName` to distinguish guest teams.
  - `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx` reads each member's `{ tenantName }` plus the current viewer's tenant name and passes both to `MemberInfo` so the cross-tenant badge reflects viewer-relative context.
  - `src/components/team/members/team-add-from-tenant-section.tsx` reads `teamTenantName` and uses it to render a contextual note when the viewer is a guest admin searching the team's tenant.
  - `src/components/layout/sidebar-section-security.tsx` reads `adminConsoleHref` and uses it to route the settings navigation entry without relying on admin-root redirect heuristics.

## Go/No-Go Gate

| ID | Subject | Status |
|-----|-----------------------------------------------|--------|
| C1 | Cross-tenant team-member display hydration | locked |
| C2 | Cross-tenant guest crypto-key lookup | locked |
| C3 | Guest existing-user lookup during invitation create | locked |
| C4 | Cross-tenant team/admin UI context alignment | locked |

## Testing Strategy

### Automated

- Unit tests for `src/lib/team/team-member-display.ts`
- Route tests for:
  - `src/app/api/teams/[teamId]/members/route.ts`
  - `src/app/api/teams/[teamId]/members/[memberId]/route.ts`
  - `src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts`
  - `src/app/api/teams/[teamId]/rotate-key/data/route.ts`
  - `src/app/api/teams/[teamId]/invitations/route.ts`
- Component tests for:
  - admin scope selector
  - member info
  - add-from-tenant section
  - sidebar security/settings navigation
- Bypass allowlist check:
  - `node scripts/checks/check-bypass-rls.mjs`

### Manual

1. Guest member accepts invitation into another tenant's team and appears in members list.
2. Guest admin opens the same members list and sees pending invitations, tenant labels, and add-from-tenant note with the team tenant name.
3. Guest admin changes a member role and verifies the updated row still renders.
4. Guest member completes key distribution and no longer remains stuck in "waiting for key distribution."
5. Team key rotation includes guest members and completes without missing public-key failures.
6. Attempting to invite an already-added guest user's email returns the member-already-exists error.
7. While a team vault is selected, clicking sidebar "Admin Console" opens that team's admin screen; while personal vault is selected, it opens tenant admin.

## Considerations & Constraints

1. Guest membership means `team_members.tenant_id` can validly differ from `users.tenant_id`; this is expected, not corruption.
2. Bypass is justified only for data that must cross home-tenant boundaries after the team-scoped row set is already known.
3. This plan does not redefine SCIM group behavior for guest members.
4. This plan does not redesign tenant membership semantics; it only makes existing guest-team behavior work correctly.
5. Existing admin-root redirect behavior may still exist for direct `/admin` navigation, but the sidebar entry must not depend on it.

## User Operation Scenarios

1. A tenant owner invites `ng@jpng.jp` from another tenant into the security team as a guest member. The guest logs in and appears in the team members list with their home tenant shown.
2. The same guest is promoted to team admin. They open the team members page, see the team's pending invitations, and the "Add from tenant" section explicitly says the searchable tenant is the team tenant, not their own.
3. The guest admin clicks "Admin Console" from the sidebar while the security team vault is selected and lands on `/admin/teams/{teamId}/general`.
4. The guest admin switches back to personal vault, clicks "Admin Console," and lands on tenant admin.
5. An owner tries to invite the already-added guest again by email and receives `ALREADY_A_MEMBER` instead of a new invitation.
