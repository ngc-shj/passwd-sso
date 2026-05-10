# Code Review: team-guest-cross-tenant-admin
Date: 2026-05-10
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### [F1] Major: Sidebar admin console link 404s for team-only admins in personal-vault context
- File: `src/components/layout/sidebar-content.tsx:101-104`
- Evidence:
  ```ts
  const adminConsoleHref =
    vaultContext.type === "team"
      ? `/admin/teams/${scopedTeamId}/general`
      : "/admin/tenant/members";
  ```
  Combined with `src/components/layout/sidebar.tsx:94`: `const isAdmin = isTenantAdmin || teams.some((t) => isTeamAdminRole(t.role))`. And `src/app/[locale]/admin/tenant/layout.tsx:14-16` calls `notFound()` when `!isTenantAdminRole(tenantRole)`.
- Problem: Before this PR, the link pointed to `/admin`, which `src/app/[locale]/admin/page.tsx` redirects to `/admin/teams/{firstAdminTeam}/general` for users who are team admins but **not** tenant admins. The new explicit `/admin/tenant/members` link bypasses that redirect. A user with tenant role MEMBER but team OWNER/ADMIN sees the admin link in personal-vault context, clicks it, and hits `notFound()`.
- Impact: Functional regression for cross-tenant guest admins (and any team-only admin) when their personal vault is selected. Contradicts plan C4 acceptance criterion #4.
- Fix: Only set `adminConsoleHref` to `/admin/tenant/members` when `isTenantAdmin` is true; otherwise fall back to `/admin/teams/{firstAdminTeam}/general`. Pass `isTenantAdmin` (not the union `isAdmin`) into `SidebarContent`/`SettingsNavSection`. Add a unit test for the team-only-admin + personal-vault case.

### [F2] Minor: `MemberInfo`'s `teamTenantName` prop is dead — no production caller passes it
- File: `src/components/member-info.tsx:19, 31, 35`
- Evidence: `grep -rn "teamTenantName=" src/` returns only `team-add-from-tenant-section` (different component) and the test. After C4 changes, all `MemberInfo` callers pass `viewerTenantName`.
- Problem: Fallback `comparisonTenantName = viewerTenantName ?? teamTenantName` retains a never-exercised branch.
- Fix: Remove `teamTenantName` from `MemberInfoProps` and the comparison. Drop the corresponding test case (`member-info.test.tsx:159`).

### [F3] Minor: Plan/code drift — C1 contract lists `keyDistributed` and `deactivatedAt` as output fields but `TeamMemberDisplayItem` omits them
- File: `src/lib/team/team-member-display.ts:11-20`
- Problem: Plan vs code mismatch. No deviation log entry.
- Fix: Add a deviation entry stating the fields were dropped because no consumer requires them.

### [F4] Minor: `TeamMemberDisplayRow` input spec narrower than plan implies
- File: `src/lib/team/team-member-display.ts:4-9`
- Problem: Helper consumes only `id, userId, role, createdAt`; plan listed extra fields.
- Fix: JSDoc clarifying the actual input contract; deviation log entry.

## Security Findings

### [S1] Minor: Over-fetch of full User row across tenants in invitation creation
- File: `src/app/api/teams/[teamId]/invitations/route.ts:81-83`
- Evidence: `prisma.user.findUnique({ where: { email } })` with no `select` returns every User column for any user across all tenants — including `encryptedSecretKey`, `masterPasswordServerHash`, `encryptedEcdhPrivateKey`, `recoveryEncryptedSecretKey`, `recoveryVerifierHmac`, KDF metadata. Only `existingUser.id` is consumed downstream.
- Attacker: Authenticated user with `MEMBER_INVITE` permission on any team.
- Attack vector: Indirect log-leak. `withRequestLog` logs `{ err, durationMs }` on unhandled exceptions. `src/lib/logger.ts:22-40` redact list does NOT cover `encryptedEcdhPrivateKey`, `masterPasswordServerHash`, `recoveryEncryptedSecretKey`, etc. If any downstream code path attaches `existingUser` to an Error context, the full row can land in stdout/Sentry.
- Impact: Potential information disclosure of private-key-encryption material for arbitrary users across all tenants, indexed by attacker-supplied email.
- Fix: `prisma.user.findUnique({ where: { email }, select: { id: true } })` — aligns with C2/C1 minimization patterns in this PR.

### [S2] Minor: check-bypass-rls allowlist over-grants invitations route
- File: `scripts/checks/check-bypass-rls.mjs:42`
- Evidence: `["src/app/api/teams/[teamId]/invitations/route.ts", ["user", "teamInvitation", "team"]]` — yet only `prisma.user.findUnique` is inside `withBypassRls`. SCAN_RADIUS=10 picks up adjacent team-RLS calls.
- Impact: Future regression that genuinely moves `prisma.teamInvitation.*`/`prisma.team.*` inside `withBypassRls` would pass CI silently.
- Fix: Reduce allowlist entry to `["user"]`.

### [S3] Minor: tenantMember bypass query lacks defense for multi-tenant invariant
- File: `src/lib/team/team-member-display.ts:40-44`
- Evidence: `Map(...)` last-write-wins on duplicate keys; `resolveUserTenantIdFromClient` (`src/lib/tenant-context.ts`) explicitly throws `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` for the same case.
- Impact: Label-correctness only — silent mislabeling on transient invariant violation.
- Fix: Add `take: 1` and `orderBy: { createdAt: "asc" }` for stability, OR throw on duplicate detection mirroring `resolveUserTenantIdFromClient`.

## Testing Findings

### [T1] Major: Guest re-invite test does not assert the `ALREADY_A_MEMBER` error code
- File: `src/app/api/teams/[teamId]/invitations/route.test.ts:154-173`
- Problem: The route has 3 paths returning 409 (`INVITATION_ALREADY_SENT`, `ALREADY_A_MEMBER`, `SCIM_MANAGED_MEMBER`). Test asserts only status 409.
- Impact: A regression returning the wrong error code for guest re-invite slips through.
- Fix: Add `expect(json.error).toBe("ALREADY_A_MEMBER")`.

### [T2] Major: `adminConsoleHref` computation in `sidebar-content.tsx` is not tested at orchestration level
- File: `src/components/layout/sidebar-content.test.tsx:28-32`
- Evidence: `SettingsNavSection` is fully mocked as a plain div, dropping `adminConsoleHref`. The new computation has no assertion.
- Impact: A bug routing always to `/admin/tenant/members` regardless of vault scope ships green.
- Fix: Capture props passed to mocked `SettingsNavSection` and assert `adminConsoleHref` for team-vault and personal-vault cases.

### [T3] Major: `getAdminTeamMemberships` `tenantName`/`isCrossTenant` derivation has no test coverage
- File: `src/lib/auth/access/team-auth.ts:141-173`
- Evidence: No `team-auth.test.ts` exercises this function.
- Impact: C4's "guest admin sees tenant name in admin scope selector" is end-to-end untested.
- Fix: Add unit test covering same-tenant (`isCrossTenant: false`) and cross-tenant (`isCrossTenant: true`, `tenantName: <other>`) cases.

### [T4] Major: PUT response test enshrines deviation from C1 (missing `tenantName`)
- File: `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts:262-307`
- Evidence: Test asserts response shape WITHOUT `tenantName`; `buildMemberRoleResponse` (route.ts:30-37) strips it.
- Problem: C1 lists `tenantName` as required output. After role change UI loses cross-tenant badge until next list refresh.
- Fix options: (a) update `buildMemberRoleResponse` to include `tenantName` and assert it (matches C1); (b) record deviation with rationale (e.g., "list refresh is cheap") and document the trade-off.

### [T5] Major: Route-level "drop members with no hydratable user profile" untested
- File: `src/app/api/teams/[teamId]/members/route.test.ts:104-224`
- Problem: Only the helper-level test covers C1's "exclude unhydratable members"; route-level integration is not asserted.
- Fix: Add one route GET test supplying 2 members but only 1 matching user, asserting `json` length is 1.

### [T6] Minor: `transfer-ownership` page `viewerTenantName` derivation untested
- File: `src/app/[locale]/admin/teams/[teamId]/members/transfer-ownership/page.tsx:61`

### [T7] Minor: `route.test.ts` GET tenantName-null branch is redundant with helper test
- File: `src/app/api/teams/[teamId]/members/route.test.ts:141-161`

## Adjacent Findings

[Adjacent F-A] Major (Functionality → Security/Testing): `tenantMember.findMany` may return zero rows for users mid-revocation; UI loses cross-tenant badge silently
- File: `src/lib/team/team-member-display.ts:40-43`
- Routing: Security expert confirmed via S3 (label-correctness only, not data leak); Testing should add a regression test for `tenantName === null` handling.

[Adjacent S-A] Minor (Security → Out-of-PR scope): Pino redact list missing User-row crypto fields
- File: `src/lib/logger.ts:22-40`
- Routing: Pre-existing; documented for future PR.

[Adjacent T-A] Minor (Testing → Functionality): Route GET test does not assert `tenantMember.findMany` was called via bypass
- File: `src/app/api/teams/[teamId]/members/route.test.ts:185-224`

## Quality Warnings
None. All findings include file:line, evidence, and concrete fixes.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — `buildTeamMemberDisplayItems` correctly centralized; `TeamScopeOption` extracted and reused.
- R2 (Constants hardcoded): Checked — `BYPASS_PURPOSE.CROSS_TENANT_LOOKUP` constant used.
- R3 (Bypass scope discipline): Checked — bypass calls scoped narrowly. Allowlist updated.
- R4-R7: Checked — no issue.
- R8 (Plan vs implementation): F1, F3, F4.
- R9 (i18n key parity en/ja): Checked — `addFromTenantCrossTenantNote` added to both.
- R10-R37: Checked or N/A — see specific findings.

### Security expert
- R1-R37: Checked or N/A — see Security Findings.
- RS1 (Timing-safe comparison): N/A — no new credential comparison paths.
- RS2 (Rate limiter on new routes): N/A — no new auth endpoints.
- RS3 (Input validation at boundaries): Checked — Zod schemas preserved.
- RS4 (Personal-identifying data): Partial — see S1 over-fetch.

### Testing expert
- R1-R37: Checked or N/A — see findings.
- RT1 (Mock-reality divergence): T2, T4.
- RT2 (Testability verification): T2, T3.
- RT3 (Shared constant in tests): Checked — module-scope constants.
- RT4 (Race-test vacuous-pass guard): Checked — confirm-key TOCTOU test OK.
- RT5 (Test call-path includes production primitive): Mixed — T2, T3, T5.

## Resolution Status

### [F1] Major Sidebar admin console link 404s for team-only admins — Resolved
- Action: Plumbed `isTenantAdmin` separately from the union `isAdmin` through `Sidebar` → `useSidebarViewModel` → `SidebarContent`. Extracted `resolveAdminConsoleHref` helper with explicit branches: team vault → team admin home; personal + tenant admin → tenant admin home; personal + team-only admin → first admin team's home; defensive fallback otherwise. Added 3 sidebar-content tests for each branch.
- Modified: `src/components/layout/sidebar-content.tsx` (helper + props), `src/components/layout/sidebar.tsx` (forward isTenantAdmin), `src/hooks/sidebar/use-sidebar-view-model.ts` (forward isTenantAdmin), `src/components/layout/sidebar-content.test.tsx` (capture SettingsNavSection props + 3 new tests).

### [F2] Minor `MemberInfo` `teamTenantName` prop is dead — Resolved
- Action: Removed `teamTenantName` from `MemberInfoProps` and the comparison expression. Dropped the obsolete fallback test.
- Modified: `src/components/member-info.tsx`, `src/components/member-info.test.tsx`.

### [F3] Minor C1 output drift — Resolved (deviation logged)
- Action: Recorded D1 in deviation log explaining the omitted `keyDistributed`/`deactivatedAt` (no consumer reads them).
- Modified: `docs/archive/review/team-guest-cross-tenant-admin-deviation.md`.

### [F4] Minor C1 input drift — Resolved (JSDoc + deviation)
- Action: Added JSDoc on `TeamMemberDisplayRow` documenting actual inputs; recorded D2 in deviation log.
- Modified: `src/lib/team/team-member-display.ts`, `docs/archive/review/team-guest-cross-tenant-admin-deviation.md`.

### [S1] Minor Over-fetch in invitation existing-user lookup — Resolved
- Action: Added `select: { id: true }` to the bypass `prisma.user.findUnique`. Updated co-located test to assert the new shape.
- Modified: `src/app/api/teams/[teamId]/invitations/route.ts`, `src/app/api/teams/[teamId]/invitations/route.test.ts`.

### [S2] Minor check-bypass-rls allowlist over-grants invitations route — Resolved
- Action: Reordered `teamContextPromise` and `existingUserPromise` so the bypass call is below the team-RLS block (out of SCAN_RADIUS=10 reach for `teamInvitation`/`team`). Narrowed the file's allowlist entry to `["user"]`.
- Modified: `src/app/api/teams/[teamId]/invitations/route.ts`, `scripts/checks/check-bypass-rls.mjs`.

### [S3] Minor tenantMember bypass query lacks defense for multi-tenant invariant — Resolved
- Action: Added `orderBy: { createdAt: "asc" }` for stable selection if the single-active-tenant invariant is ever transiently violated. Inline comment cross-references the invariant. Updated helper test assertion.
- Modified: `src/lib/team/team-member-display.ts`, `src/lib/team/team-member-display.test.ts`.

### [T1] Major Guest re-invite test does not assert ALREADY_A_MEMBER — Resolved
- Action: Added `expect(json.error).toBe("ALREADY_A_MEMBER")` and tightened the bypass call assertion to include `select: { id: true }`.
- Modified: `src/app/api/teams/[teamId]/invitations/route.test.ts`.

### [T2] Major adminConsoleHref untested at orchestration — Resolved (with F1)
- Action: `SettingsNavSection` mock now captures props via spy; 3 new tests assert `adminConsoleHref` for team vault, personal+tenant-admin, personal+team-only-admin.
- Modified: `src/components/layout/sidebar-content.test.tsx`.

### [T3] Major getAdminTeamMemberships untested — Resolved
- Action: Added 3 unit tests for `getAdminTeamMemberships` (same-tenant `isCrossTenant: false`, cross-tenant `isCrossTenant: true` with `tenantName`, role/active filter).
- Modified: `src/lib/auth/access/team-auth.test.ts` (added `vi.hoisted` mocks for `resolveUserTenantIdFromClient`, `withBypassRls`, `team-policy`).

### [T4] Major PUT response enshrines C1 contract drift — Resolved
- Action: Added `tenantName` to `buildMemberRoleResponse`. Updated existing test assertion to include `tenantName: "Guest Tenant"`. Security analysis confirmed the disclosure boundary does not widen — GET already returns `tenantName` to the same role.
- Modified: `src/app/api/teams/[teamId]/members/[memberId]/route.ts`, `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts`.

### [T5] Major Route-level "drop unhydratable members" untested — Resolved
- Action: Added route GET test asserting that members whose user profile is not visible in the bypass lookup are excluded from the response, AND that `tenantMember.findMany` was called with the expected `where` shape (closes Adjacent T-A).
- Modified: `src/app/api/teams/[teamId]/members/route.test.ts`.

### [T6] Minor transfer-ownership viewerTenantName derivation untested — Skipped (Anti-Deferral)
- Anti-Deferral check: 30-minute rule + essence filter.
- Justification (recorded as D3 in deviation log):
  - Worst case: silent miswiring of cross-tenant badge if the `if (!isOwner)` gate is relaxed without updating the viewerTenantName derivation.
  - Likelihood: Low — gate is the page's primary access control.
  - Cost to fix: helper extraction adds indirection for a 1-liner; full client-component test ~30 min.
- Orchestrator sign-off: Confirmed; carry to follow-up PR if the page gains additional access modes.

### [T7] Minor route.test.ts tenantName-null branch redundancy — Skipped (defense-in-depth)
- Disposition: Per the original finding's recommendation, keep as a route-level smoke test.

### [Adjacent F-A] Major tenantName=null edge case in mid-revocation — Resolved
- Action: Closed indirectly by S3 (orderBy stabilizes selection); tenant-name=null handling is verified in `team-member-display.test.ts:141-161`.

### [Adjacent S-A] Minor pino redact list missing crypto fields — Deferred (out of PR scope)
- Action: Recorded as TODO in deviation log; mitigated within this PR by S1's `select: { id: true }` minimization on the new bypass call.

### [Adjacent T-A] Minor route GET should assert tenantMember.findMany via bypass — Resolved (with T5)

### Pre-existing test breakage in `__tests__/api/teams/team-invitations.test.ts` — Resolved
- The test file (older, parallel to the co-located route.test.ts) was failing on this branch because withBypassRls was added to the route in commit `427bf342` but the test had no mock for `@/lib/tenant-rls`. Per CLAUDE.md "Fix ALL errors", added `vi.hoisted` mock for `withBypassRls` to mirror the co-located test pattern.
- Modified: `src/__tests__/api/teams/team-invitations.test.ts`.

## Verification

- `node scripts/checks/check-bypass-rls.mjs` → OK
- `npm run lint` → clean
- `npm test` → 865 files / 10207 tests pass / 1 skipped
- `npm run build` → ✓ Compiled successfully

## Round 2 — Incremental Verification

All Round 1 fixes verified by the three sub-agents:

- **Functionality**: F1/F2/F3/F4 confirmed resolved with file:line evidence. New findings:
  - **N1 Minor (pre-existing)**: team-vault branch of `resolveAdminConsoleHref` may yield a dead `/admin/teams/{id}/general` link if user is admin of *another* team but viewer of the selected team. Server-side layout gates correctly `notFound()`; UX bug only. Out of PR scope (matches pre-PR behavior). Logged as TODO in deviation log.
  - **N2 Minor (cosmetic)**: comment block on `resolveAdminConsoleHref` had awkward line wrapping. Applied directly.
- **Security**: S1/S2/S3/T4 confirmed resolved. F1 plumbing verified non-elevating (server-side gates at `/admin/tenant/*` and `/admin/teams/[teamId]/*` layouts enforce roles). The `withBypassRls` mock in `__tests__/api/teams/team-invitations.test.ts` is safe (CI guard skips test files at `check-bypass-rls.mjs:170`). No new findings, no regressions.
- **Testing**: T1/T2/T3/T4/T5 confirmed resolved. All 100 tests in modified files pass. One cosmetic nit: T3 test description "with the home-tenant name" was misleading; renamed to "and surfaces the team's home-tenant name". Applied directly.

## Round 2 — Tightening-only skip

Per Phase 3 Step 3-8 criteria:
1. All new Round 2 findings sit inside Round 1's fix scope (or are pre-existing flagged for follow-up).
2. Severity is inline minor (cosmetic comment formatting, test description wording).
3. None touch a security boundary (R35 Tier-2 list).

Round 3 skipped. Inline-minor fixes applied directly:
- `src/components/layout/sidebar-content.tsx:63-74` — comment block reformatted.
- `src/lib/auth/access/team-auth.test.ts:259` — test description renamed.

N1 pre-existing finding logged in `team-guest-cross-tenant-admin-deviation.md` as a TODO for a follow-up PR.


