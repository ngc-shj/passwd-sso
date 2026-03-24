# Coding Deviation Log: expand-api-test-coverage
Created: 2026-03-23T00:00:00+09:00

## Deviations from Plan

### [D1]: New helper files not created as separate modules
- **Plan description**: Five new helper files to be created: `e2e/helpers/tenant.ts`, `e2e/helpers/team.ts`, `e2e/helpers/emergency-access.ts`, `e2e/helpers/password-entry.ts`, `e2e/helpers/share-link.ts`
- **Actual implementation**: Only `seedTenant()` and `seedTenantMember()` were implemented, and they were added directly to the existing `e2e/helpers/db.ts` rather than a separate `tenant.ts`. The other four helper modules (`team.ts`, `emergency-access.ts`, `password-entry.ts`, `share-link.ts`) were not created at all.
- **Reason**: Not documented. Likely deferred or consolidated.
- **Impact scope**: `e2e/helpers/db.ts` (grown larger than planned); `e2e/helpers/team.ts`, `e2e/helpers/emergency-access.ts`, `e2e/helpers/password-entry.ts`, `e2e/helpers/share-link.ts` are absent.

### [D2]: share-link-public.spec.ts does not test a pre-seeded valid token
- **Plan description**: Step 40 — use token seeded by `seedShareLink()` in global-setup to access `/s/[token]` without any session cookie and verify entry content is displayed. The plan explicitly required `seedShareLink()` to pre-seed a real share link with SHA-256-hashed token stored in `password_shares`.
- **Actual implementation**: `share-link-public.spec.ts` only tests non-existent/invalid tokens (all four tests expect "Link Not Found"). No real share link is seeded and no content-display assertion exists.
- **Reason**: `seedShareLink()` was never implemented (see D1); without it, testing a valid public link was not possible.
- **Impact scope**: The core positive test case (unauthenticated user can view shared entry content) is not covered.

### [D3]: emergency-access.spec.ts does not test the IDLE→REQUESTED→ACTIVATED flow or the negative 403 case
- **Plan description**: Step 38 — two flows required: (a) happy path: seed grant at IDLE status, then via UI drive eaGrantee requests access → eaGrantor approves → eaGrantee accesses vault (read-only); (b) negative test: seed grant at REQUESTED status with `waitExpiresAt` in the future → eaGrantee tries vault access → expect 403.
- **Actual implementation**: Tests only cover page load, creating a grant via UI, verifying "Pending" status on the grantor side, and the grantee's page rendering. No `seedEmergencyGrant()` call (helper not created), no request/approve flow through UI, and no negative 403 assertion.
- **Reason**: `e2e/helpers/emergency-access.ts` was not created (see D1); without a pre-seeded grant at specific statuses, the full state-machine test is not feasible.
- **Impact scope**: EA state machine transitions (IDLE → REQUESTED → ACTIVATED) and wait-period enforcement are not E2E tested.

### [D4]: teams.spec.ts skips invitation acceptance and team entry visibility for member
- **Plan description**: Step 37 — teamOwner creates team, invites teamMember via email, **member accepts** in separate context, team password CRUD by both users.
- **Actual implementation**: The invitation acceptance step is explicitly skipped with a comment: "full invite acceptance requires a token URL exchange which is out of scope here." The last test (`teamMember: can see the team entry after joining`) does not assert entry visibility; it only confirms the page renders and that `teamMember.email` is truthy.
- **Reason**: Token-URL-based invitation acceptance requires either intercepting the email link or pre-seeding an accepted membership. `seedTeamMember()` was not implemented (see D1).
- **Impact scope**: Multi-user team membership flow is untested; team entry visibility from a member's perspective is not asserted.

### [D5]: auth-error.spec.ts exceeds the plan's scope (minor positive deviation)
- **Plan description**: Step 41 — three scenarios: AccessDenied, Configuration, and redirect of `/ja/dashboard` without session.
- **Actual implementation**: Six scenarios implemented — the three planned plus three additional: `Verification` error (magic-link expired), unknown error code fallback, no query string fallback, and en-locale rendering.
- **Reason**: Implementer added extra coverage. The three planned scenarios are all present and correct.
- **Impact scope**: More coverage than required; no regressions.

### [D6]: `share_access_logs` not included in cleanup() Phase 1
- **Plan description**: Cleanup Extension Phase 1 lists `share_access_logs` as the first leaf table to delete before `password_shares`.
- **Actual implementation**: The actual `cleanup()` implementation does not delete from `share_access_logs` before deleting `password_shares`. Since `password_shares` is deleted in the existing Phase 4 deletions array via `{ table: "password_shares", column: "created_by_id" }`, and `share_access_logs` references `password_shares.id` with `onDelete: Cascade` semantics, this is safe in practice but diverges from the explicit plan.
- **Reason**: Not documented.
- **Impact scope**: Low risk if FK has CASCADE delete; could cause constraint violations if it does not.
