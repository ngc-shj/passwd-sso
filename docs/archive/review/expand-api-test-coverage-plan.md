# Plan: expand-api-test-coverage

## Context

passwd-sso has strong unit test coverage (149/149 API routes tested, 60%+ line coverage), but E2E test coverage is minimal: only 7 spec files covering vault lifecycle and basic password CRUD (5 out of 32 pages, 84% gap). This plan adds comprehensive E2E tests for all untested user flows, ensuring end-to-end reliability across authentication, vault management, teams, emergency access, sharing, and admin features.

## Objective

Achieve full E2E coverage for all user-facing flows in passwd-sso by adding ~22 new Playwright spec files, expanding the test infrastructure (new users, DB helpers, page objects), and covering single-user, multi-user, and public page scenarios.

## Requirements

### Functional
- All major user flows must have at least one E2E test
- Tests must handle i18n (ja/en) via regex selectors
- Tests must be serial (vault state is in-memory, per-browser)
- Destructive tests must use dedicated users to avoid contaminating other tests

### Non-functional
- All existing 7 E2E specs must continue to pass
- Tests must pass in both local dev and CI environments
- No flaky tests (proper waits for PBKDF2, crypto operations, network requests)

## Technical Approach

### Infrastructure Extensions

#### Shared Test Tenant

All E2E users must belong to a tenant (users.tenant_id is NOT NULL). Create a shared test tenant in global-setup before seeding any users:

```
E2E Test Tenant:
  id: "00000000-0000-4000-e2e0-tenant0000001"
  name: "E2E Test Tenant"
  slug: "e2e-test-tenant"
```

All seedUser() and seedSession() calls must pass this tenant_id explicitly. Both functions' signatures must be updated to include tenant_id parameter, and their INSERT statements must include the tenant_id column. Additionally, change `ON CONFLICT (id) DO NOTHING` to `ON CONFLICT (id) DO UPDATE SET ...` (UPSERT) in seedUser/seedSession/seedVaultKey so that re-runs after partial cleanup correctly reset stale state (e.g., lockout counters, changed passphrases).

#### New Test Users (add 7 to existing 5 = 12 total)

| User | ID | Email | Purpose |
|------|----|-------|---------|
| teamOwner | `e2e0-..06` | e2e-team-owner@test.local | Team creation, member management |
| teamMember | `e2e0-..07` | e2e-team-member@test.local | Team invitation acceptance |
| eaGrantor | `e2e0-..08` | e2e-ea-grantor@test.local | Emergency access grantor |
| eaGrantee | `e2e0-..09` | e2e-ea-grantee@test.local | Emergency access grantee |
| tenantAdmin | `e2e0-..0a` | e2e-tenant-admin@test.local | Tenant admin (ADMIN role) |
| passphraseChange | `e2e0-..0b` | e2e-passphrase-change@test.local | Passphrase change (destructive) |
| keyRotation | `e2e0-..0c` | e2e-key-rotation@test.local | Key rotation (destructive) |

All vault-ready. tenantAdmin also needs tenant_members record with ADMIN role.

#### New DB Helpers

- `e2e/helpers/tenant.ts` — seedTenant(), seedTenantMember()
- `e2e/helpers/team.ts` — seedTeam(), seedTeamMember(), seedTeamInvitation()
- `e2e/helpers/emergency-access.ts` — seedEmergencyGrant()
- `e2e/helpers/password-entry.ts` — seedPasswordEntry() using `e2e/helpers/crypto.ts` aesGcmEncrypt() for properly formatted encrypted blobs (NOT placeholder strings). Fields: encryptedBlob, blobIv, blobAuthTag, encryptedOverview, overviewIv, overviewAuthTag, keyVersion.
- `e2e/helpers/share-link.ts` — seedShareLink(createdById, tenantId) for public access tests. Generates token via `randomBytes(32)`, stores SHA-256 hash in `password_shares.token_hash`, and writes the raw token to `.auth-state.json` (same pattern as session tokens). Uses `encryptShareData()` logic for server-side AES-256-GCM encryption with `SHARE_MASTER_KEY` from `.env.local`.

#### New Page Objects

- `sidebar-nav.page.ts` — Navigation links (All, Favorites, Archive, Trash, Tags, Folders, Teams)
- `trash.page.ts` — Restore button, empty trash button
- `settings.page.ts` — Tab navigation (Account/Security/Developer), sub-section access
- `share-links.page.ts` — Share link list, type/status filters, revoke, access logs
- `teams.page.ts` — Team list, create dialog
- `team-dashboard.page.ts` — Team entries, members tab, settings
- `emergency-access.page.ts` — Grant list, status steps, action buttons
- `watchtower.page.ts` — Scan trigger, results display
- `audit-logs.page.ts` — Filter controls, pagination, log entries
- `import.page.ts` — File upload, format selection
- `export.page.ts` — Format selection, download trigger

All selectors follow i18n regex pattern: `/English|日本語/i`

#### Cleanup Extension

`e2e/helpers/db.ts` cleanup() must add FK-ordered deletion (child → parent):

```
Phase 1 (leaf tables):
  share_access_logs
  team_member_keys
  team_password_entry_histories
  team_password_entries
  team_tags
  team_folders
  team_invitations
  emergency_access_key_pairs
  personal_log_access_grants (onDelete: Restrict — must delete before users)
  webauthn_credentials
  password_entry_histories

Phase 2 (intermediate tables):
  team_members
  emergency_access_grants
  password_shares
  api_keys
  notifications
  folders

Phase 3 (parent tables — after existing cleanup):
  teams
  tenant_members (WHERE user email LIKE 'e2e-%@test.local')

Phase 4 (existing cleanup — unchanged):
  audit_logs, attachments, password_entries, tags, vault_keys,
  extension_tokens, sessions, users

Phase 5 (last):
  tenants (WHERE id = E2E test tenant ID)
```

#### Multi-User Context Switching Pattern

For tests involving 2 users (teams, emergency-access), use **separate browser contexts**:

```typescript
// Pattern for multi-user tests
const ownerContext = await browser.newContext();
const memberContext = await browser.newContext();

await injectSession(ownerContext, teamOwner.sessionToken);
await injectSession(memberContext, teamMember.sessionToken);

const ownerPage = await ownerContext.newPage();
const memberPage = await memberContext.newPage();

// Owner creates team...
// Member accepts invitation...

await ownerContext.close();
await memberContext.close();
```

This avoids cookie/state contamination between users.

#### Destructive Test Reset Strategy

For `passphrase-change.spec.ts` and `settings-key-rotation.spec.ts`:
- These specs use dedicated users (passphraseChange, keyRotation) that are NOT shared with any other spec
- Each spec is self-contained: it unlocks with the known passphrase, performs the destructive action, and verifies the result within the same spec
- No afterEach reset is needed because global-setup re-seeds these users from scratch on each full test run
- CI retry safety: if the spec fails mid-way, the next full run's global-setup cleanup + re-seed restores the user to a known state

### Files to Modify

| File | Change |
|------|--------|
| `e2e/helpers/db.ts` | Add 7 new user definitions, add E2E tenant constant, extend cleanup() with full FK-ordered table list |
| `e2e/helpers/fixtures.ts` | Extend AuthState interface for 7 new users |
| `e2e/global-setup.ts` | Seed E2E tenant first, seed 7 new vault-ready users with tenant_id, create tenant_member for tenantAdmin |
| `e2e/global-teardown.ts` | No change needed (cleanup via db.cleanup()) |

### Files to Create

| File | Description |
|------|-------------|
| `e2e/helpers/tenant.ts` | Tenant seeding helpers |
| `e2e/helpers/team.ts` | Team seeding helpers |
| `e2e/helpers/emergency-access.ts` | Emergency access grant seeding |
| `e2e/helpers/password-entry.ts` | Password entry seeding with real crypto via crypto.ts |
| `e2e/helpers/share-link.ts` | Share link seeding for public access tests |
| `e2e/page-objects/sidebar-nav.page.ts` | Sidebar navigation |
| `e2e/page-objects/trash.page.ts` | Trash page interactions |
| `e2e/page-objects/settings.page.ts` | Settings tabs |
| `e2e/page-objects/share-links.page.ts` | Share links management |
| `e2e/page-objects/teams.page.ts` | Teams list + create |
| `e2e/page-objects/team-dashboard.page.ts` | Team dashboard |
| `e2e/page-objects/emergency-access.page.ts` | Emergency access management |
| `e2e/page-objects/watchtower.page.ts` | Security scanner |
| `e2e/page-objects/audit-logs.page.ts` | Audit log viewer |
| `e2e/page-objects/import.page.ts` | Import wizard |
| `e2e/page-objects/export.page.ts` | Export page |
| `e2e/tests/favorites.spec.ts` | Favorite toggle + /favorites view |
| `e2e/tests/archive.spec.ts` | Archive/unarchive + /archive view |
| `e2e/tests/trash.spec.ts` | /trash view, restore, empty trash |
| `e2e/tests/tags.spec.ts` | Tag CRUD, assign to entry, filter |
| `e2e/tests/folders.spec.ts` | Folder CRUD, assign to entry, filter |
| `e2e/tests/bulk-operations.spec.ts` | Multi-select, bulk archive/trash/restore |
| `e2e/tests/passphrase-change.spec.ts` | Change passphrase, re-unlock |
| `e2e/tests/share-link.spec.ts` | Create share link, public access at /s/[token] |
| `e2e/tests/send-text.spec.ts` | Create text send, public access |
| `e2e/tests/import-export.spec.ts` | Import CSV/JSON, export |
| `e2e/tests/watchtower.spec.ts` | Run security scan |
| `e2e/tests/settings-sessions.spec.ts` | View active sessions |
| `e2e/tests/settings-api-keys.spec.ts` | API key create/delete |
| `e2e/tests/settings-travel-mode.spec.ts` | Enable/disable travel mode |
| `e2e/tests/settings-key-rotation.spec.ts` | Vault key rotation |
| `e2e/tests/audit-logs.spec.ts` | Personal audit log view |
| `e2e/tests/password-generator.spec.ts` | Generate password with settings |
| `e2e/tests/teams.spec.ts` | Team create, invite, accept, team CRUD |
| `e2e/tests/emergency-access.spec.ts` | Grant, accept, request, approve, vault access |
| `e2e/tests/tenant-admin.spec.ts` | Member management, security policy |
| `e2e/tests/share-link-public.spec.ts` | /s/[token] unauthenticated access (uses seeded token) |
| `e2e/tests/auth-error.spec.ts` | /auth/error page display |

## Implementation Steps

### Step 1: E2E Infrastructure Extension
1. Extend `e2e/helpers/db.ts` — add E2E tenant constant, 7 new user constants, extend cleanup() with full FK-ordered table list (see Cleanup Extension section)
2. Extend `e2e/helpers/fixtures.ts` — add 7 new users to AuthState interface
3. Extend `e2e/global-setup.ts` — seed E2E tenant first, then seed 7 new vault-ready users (all with tenant_id), create tenant_members record (ADMIN) for tenantAdmin
4. Create `e2e/helpers/tenant.ts` — seedTenant(), seedTenantMember()
5. Create `e2e/helpers/team.ts` — seedTeam(), seedTeamMember(), seedTeamInvitation()
6. Create `e2e/helpers/emergency-access.ts` — seedEmergencyGrant()
7. Create `e2e/helpers/password-entry.ts` — seedPasswordEntry() using crypto.ts aesGcmEncrypt()
8. Create `e2e/helpers/share-link.ts` — seedShareLink() with known token for public tests

### Step 2: Page Objects (Phase 1 — single-user)
9. Create `e2e/page-objects/sidebar-nav.page.ts`
10. Create `e2e/page-objects/trash.page.ts`
11. Create `e2e/page-objects/settings.page.ts`
12. Create `e2e/page-objects/share-links.page.ts`
13. Create `e2e/page-objects/watchtower.page.ts`
14. Create `e2e/page-objects/audit-logs.page.ts`
15. Create `e2e/page-objects/import.page.ts`
16. Create `e2e/page-objects/export.page.ts`

### Step 3: Single-User E2E Tests
17. `favorites.spec.ts` — toggle favorite on entry, navigate to /favorites, verify listed, unfavorite
18. `archive.spec.ts` — archive entry via menu, navigate to /archive, verify, unarchive
19. `trash.spec.ts` — verify /trash shows deleted entries, restore one, empty trash (dedicated entries)
20. `tags.spec.ts` — create tag in sidebar, assign to entry, navigate to /tags/[id], verify filter
21. `folders.spec.ts` — create folder, assign entry, navigate to /folders/[id], verify filter
22. `bulk-operations.spec.ts` — select multiple entries, bulk archive, verify in /archive, bulk restore
23. `passphrase-change.spec.ts` — (passphraseChange user) settings > change passphrase, lock, unlock with new
24. `share-link.spec.ts` — create share link for entry, copy token, navigate to /s/[token] in new context
25. `send-text.spec.ts` — create text send, navigate to /s/[token] in new context, verify text
26. `import-export.spec.ts` — export entries as CSV, import from CSV file, verify imported entries
27. `watchtower.spec.ts` — navigate to /watchtower, trigger scan, verify results display
28. `settings-sessions.spec.ts` — navigate to settings > sessions tab, verify current session listed
29. `settings-api-keys.spec.ts` — create API key, verify listed, delete, verify removed
30. `settings-travel-mode.spec.ts` — enable travel mode, verify UI change, disable with passphrase
31. `settings-key-rotation.spec.ts` — (keyRotation user) rotate vault key, verify entries still accessible
32. `audit-logs.spec.ts` — navigate to /audit-logs, verify recent actions listed, test filter
33. `password-generator.spec.ts` — open generator in new-password dialog, adjust settings, verify output

### Step 4: Page Objects (Phase 2 — multi-user)
34. Create `e2e/page-objects/teams.page.ts`
35. Create `e2e/page-objects/team-dashboard.page.ts`
36. Create `e2e/page-objects/emergency-access.page.ts`

### Step 5: Multi-User E2E Tests
37. `teams.spec.ts` — teamOwner creates team, invites teamMember via email, member accepts in separate context, team password CRUD by both users
38. `emergency-access.spec.ts` — eaGrantor creates grant for eaGrantee. Test two flows:
    - **Happy path**: Seed grant at IDLE status, then via UI: eaGrantee requests access → eaGrantor approves → eaGrantee accesses vault (read-only)
    - **Negative test**: Seed grant at REQUESTED status with waitExpiresAt in the future → eaGrantee tries vault access → expect 403
39. `tenant-admin.spec.ts` — tenantAdmin views members list, updates security policy (session timeout, CIDR restrictions)

### Step 6: Public Page Tests
40. `share-link-public.spec.ts` — use token seeded by `seedShareLink()` in global-setup, access /s/[token] without any session cookie, verify entry content displayed
41. `auth-error.spec.ts` — test scenarios:
    - Navigate to `/ja/auth/error?error=AccessDenied` → verify access denied message displayed
    - Navigate to `/ja/auth/error?error=Configuration` → verify configuration error message
    - Navigate to `/ja/dashboard` without session → verify redirect to `/ja/auth/signin`

## Testing Strategy

### Verification Steps
1. Run individual spec: `npx playwright test e2e/tests/favorites.spec.ts`
2. Run all E2E tests: `npx playwright test`
3. Run with trace for debugging: `npx playwright test --trace on`
4. Run headed for visual verification: `npx playwright test --headed`
5. Verify in CI-like mode: `CI=true npx playwright test`

### Test Isolation
- Non-destructive tests share `vaultReady` user
- Destructive tests use dedicated users (passphraseChange, keyRotation, lockout, reset)
- Multi-user tests use dedicated pairs (teamOwner/teamMember, eaGrantor/eaGrantee)
- Each spec creates its own test entries with unique timestamped titles
- share-link-public.spec.ts uses a pre-seeded token from global-setup (no dependency on other specs)

### Mandatory Checks Before Commit
1. `npx vitest run` — existing unit tests still pass
2. `npx next build` — production build succeeds
3. `npx playwright test` — all E2E tests pass (existing + new)

## Considerations & Constraints

| Risk | Mitigation |
|------|-----------|
| PBKDF2 latency (1-3s/unlock) | Unlock once per spec, not per test. Share vaultReady for non-destructive tests |
| Client-side encryption | Verify via UI display (decrypted result), not DB data |
| Serial execution (workers: 1) | Minimize unlock operations. Test execution time may reach 5-10 minutes |
| i18n selector fragility | Use regex `/en\|ja/i` pattern consistently. Consider data-testid for critical elements |
| Multi-user context switching | Use browser.newContext() for separate contexts per user (see pattern above) |
| FK dependency in cleanup | Delete in explicit FK-ordered phases (see Cleanup Extension section) |
| Team crypto (ECDH key exchange) | For E2E, seed team with pre-computed keys in global-setup rather than testing crypto flow |
| EA state machine | Seed grant at specific status for happy path + add negative test for wait-period enforcement |
| Destructive test CI retry | Dedicated users + global-setup re-seeds from scratch on each run |
| tenant_id NOT NULL | All users seeded with shared E2E test tenant. Tenant created first in global-setup |
| seedPasswordEntry format | Use real AES-256-GCM encryption via crypto.ts (not placeholder strings) |
| share-link-public independence | Pre-seed share link token in global-setup so spec runs without other specs |
