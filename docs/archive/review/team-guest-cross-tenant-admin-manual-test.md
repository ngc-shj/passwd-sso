# Manual Test Plan: team-guest-cross-tenant-admin

Tier classification: **R35 Tier-2** (authorization changes + tenancy boundary changes for guest team members across tenants).

Scope: end-to-end browser verification that cannot be (or has not been) covered by automated tests. Each section applies the **two-filter rule** — Filter A drops anything fully covered by an automated test; Filter B keeps items requiring real auth flow, UI rendering judgment, real crypto, or cross-process state.

## Pre-conditions

1. Two tenants seeded with admins:
   - `tenant-A` with at least one OWNER (`<owner-A>`)
   - `tenant-B` with at least one MEMBER user (`<guest-B>`)
2. A team `team-X` exists in `tenant-A` with `<owner-A>` as OWNER.
3. Both tenants have the application running against the same database (or staging) so that the cross-tenant lookup paths exercise the same RLS layer that production would.
4. Both users have completed initial vault setup so `ecdhPublicKey` is populated.
5. Replace placeholders before execution:
   - `<owner-A>` — tenant-A OWNER's login email
   - `<guest-B>` — tenant-B MEMBER's login email
   - `<other-team>` — a second team in `tenant-A` where `<owner-A>` is admin
   - `<viewer-team>` — a team in `tenant-A` where the test session user is only a viewer

## Steps

### Scenario 1 — Guest invitation accepted, visible in members list (cross-tenant hydration)

1. Sign in as `<owner-A>`. Open `/admin/teams/<team-X>/members/list`.
2. Invite `<guest-B>` by email with role MEMBER.
3. Sign out. Sign in as `<guest-B>` (in `tenant-B`).
4. Accept the invitation via the email link.
5. **Expected**: `<guest-B>` lands in `team-X`. Returning to `<owner-A>`'s session and reloading `/admin/teams/<team-X>/members/list` shows `<guest-B>` in the members list with their home-tenant name (`tenant-B`'s display name) shown as a cross-tenant badge.
6. **Rollback**: revoke `<guest-B>`'s membership via the trash/remove control on the row.

### Scenario 2 — Guest admin tenant-context labels and "add from tenant" note

1. As `<owner-A>`, promote `<guest-B>` to ADMIN via PUT role change in the members list.
2. Sign in as `<guest-B>`. Switch active vault to `team-X` (sidebar VaultSelector → team).
3. Open `/admin/teams/<team-X>/members/list`.
4. **Expected**:
   - `<guest-B>`'s own row shows their home-tenant (`tenant-B`) name as the cross-tenant badge — comparison is viewer-relative, not team-relative.
   - The "Add from tenant" section explicitly states the searchable tenant is **`tenant-A`** (the team's tenant), not `tenant-B`.
   - Pending invitations panel renders with no error.
5. **Rollback**: demote `<guest-B>` to MEMBER from `<owner-A>`'s session.

### Scenario 3 — Role change response preserves cross-tenant badge (visual verification of T4)

1. As `<owner-A>`, on `/admin/teams/<team-X>/members/list`, promote `<guest-B>` from MEMBER to ADMIN.
2. **Expected**: the row re-renders without a full list refetch, and the cross-tenant badge (`tenant-B`) remains visible on the row immediately after the optimistic update.
3. **Rollback**: demote back to MEMBER.

### Scenario 4 — Guest member key distribution completes

1. With `<guest-B>` newly added to `team-X`, sign in as `<owner-A>` and trigger key distribution from the team's settings (or wait for the auto-distribution flow).
2. Sign in as `<guest-B>` and unlock the vault.
3. **Expected**: `<guest-B>` no longer shows a "waiting for key distribution" state on `team-X` and can decrypt at least one shared password entry.
4. **Rollback**: remove `<guest-B>` from the team.

### Scenario 5 — Team key rotation includes guest members

1. As `<owner-A>` on `/admin/teams/<team-X>/general`, trigger team key rotation.
2. **Expected**: rotation completes without "missing public key" failures, and `<guest-B>`'s key blob is included in the rotation payload (verify by checking that `<guest-B>` can still decrypt entries afterward).
3. **Rollback**: not applicable (rotation is forward-only); pre-test snapshot the team encryption state if testing in staging.

### Scenario 6 — Sidebar "Admin Console" routing by vault scope (visual verification of F1)

1. Sign in as `<guest-B>` who is OWNER/ADMIN of `team-X` but only MEMBER of their own `tenant-B`.
2. Confirm the sidebar shows the "Admin Console" link (`SettingsNavSection isAdmin=true`).
3. With **personal vault** selected, click "Admin Console".
4. **Expected**: lands on `/admin/teams/<team-X>/general` (not `/admin/tenant/members`, which would 404 because `<guest-B>` is not tenant-admin in `tenant-B`).
5. Switch vault to `team-X`. Click "Admin Console" again.
6. **Expected**: lands on `/admin/teams/<team-X>/general`.
7. Sign in as `<owner-A>` (tenant-admin of `tenant-A`). With personal vault selected, click "Admin Console".
8. **Expected**: lands on `/admin/tenant/members`.

## Adversarial scenarios (Tier-2 required)

### A1 — Cross-tenant team boundary respected on PUT role change

1. As `<guest-B>` (now ADMIN of `team-X`), attempt to PUT role of `<owner-A>` to MEMBER via the UI.
2. **Expected**: server returns `CANNOT_CHANGE_HIGHER_ROLE` (403) — ADMIN cannot demote OWNER.
3. As `<guest-B>` (ADMIN of `team-X`), attempt to PUT role on a member of a different team via direct API call (e.g., `<other-team>` where `<guest-B>` has no membership).
4. **Expected**: 404 (`MEMBER_NOT_FOUND`) — team RLS hides the membership row entirely.

### A2 — Re-invite already-added guest is rejected

1. As `<owner-A>`, while `<guest-B>` is an active member of `team-X`, attempt to re-invite `<guest-B>` by email.
2. **Expected**: 409 `ALREADY_A_MEMBER`. Verify by inspecting the network response that the error code is exactly `ALREADY_A_MEMBER` (not `INVITATION_ALREADY_SENT` or `SCIM_MANAGED_MEMBER`).
3. **Note**: this is also covered by automated test T1, but visual verification of the toast/error UI on the invitation form is human-only.

### A3 — Bypass scope minimization in invitation flow

1. As `<owner-A>`, invite a brand-new email (not yet a user in any tenant). Inspect the server log (development mode) or `NEXT_TELEMETRY` capture for the request.
2. **Expected**: no `User` row's encryption material (`encryptedSecretKey`, `encryptedEcdhPrivateKey`, `masterPasswordServerHash`, etc.) appears anywhere in the request log path. Only `id` is fetched in the bypass call (verified at code level by S1 fix; here we verify the runtime log shape).

### A4 — Guest admin cannot escalate to tenant admin

1. As `<guest-B>` (ADMIN of `team-X` in `tenant-A`, MEMBER in their own `tenant-B`), navigate directly to `/admin/tenant/members` of either tenant via URL.
2. **Expected**: `tenant-A`'s `/admin/tenant/members` returns 404 (`<guest-B>` is not tenant-admin of `tenant-A`). `tenant-B`'s `/admin/tenant/members` returns 404 (or appropriate not-found) because `<guest-B>` is only MEMBER there.

### A5 — Direct member endpoint cannot expose another tenant's user metadata

1. As an unauthenticated client, attempt `GET /api/teams/<team-X>/members`.
2. **Expected**: 401.
3. As `<owner-A>`, attempt `GET /api/teams/<other-team-not-mine>/members` (a team in `tenant-A` they are not member of).
4. **Expected**: 404 (`NOT_FOUND` from `requireTeamMember`).

## Expected result (overall pass criteria)

All 6 happy-path scenarios above produce the expected outcomes, AND all 5 adversarial scenarios produce the expected reject/404/error outcomes. After the run, capture in this file inline (with date + author) the actual results for each scenario.

## Rollback

If any scenario fails:
1. Document the actual outcome inline in this file with screenshot or log excerpt.
2. Do NOT merge the PR.
3. For state changes that were applied (member added, role changed), use the per-scenario Rollback step or restore from a database snapshot.
4. For team key rotation (Scenario 5), if rotation completed but downstream decryption fails, use the previous-version key blob to recover, then investigate before re-attempting.
