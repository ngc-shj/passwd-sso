# Code Review: share-link-serve-policy-and-followups
Date: 2026-11-08
Review round: 1

Standalone Phase 3 review (no plan file) of six issue fixes on branch
`fix/share-link-serve-policy-and-followups`: #996, #998 (serve-time refusal in
`share_creator_admitted`), #997 (master-key rotation skips client-encrypted
shares), #1014 (per-entry MEMBER write gating in the UI), #1013
(`S3_FORCE_PATH_STYLE`), #960 (load-test seeder seeds a tenant).

## Changes from Previous Round
Initial review.

## Functionality Findings
- F1 [Major] Team Watchtower opened `TeamEditDialogLoader` for any entry, so the
  MEMBER own-entry rule (#1014) was not applied there.
- F2 [Major] Seeder cleanup deleted `audit_logs` by user only, before draining
  the outbox; `audit_logs.tenant_id` is RESTRICT, so a row the worker wrote for
  the tenant blocked the tenant delete. The README's manual SQL omitted
  `audit_logs`.
- F3 [Minor] Team attachment delete was shown to MEMBERs; the delete route
  requires PASSWORD_DELETE.
- F4 [Minor] Serve-path comments described only the team-membership rule.
- F5 [Minor] `docs/security/policy-enforcement.md` listed `allowSharing` /
  `requireSharePassword` as creation-time only.
- F6 [Minor] Share creation accepted a trashed entry (the link never serves).
- F7 [Minor] The `S3_FORCE_PATH_STYLE` description wrapped raggedly in `.env.example`.

## Security Findings
No findings. Verified: the widened `app.bypass_tables` list is report-mode only
(`rls_bypass_enforced()` is false), so the function reads nothing new; the ACL
survives CREATE OR REPLACE; every serve path (page, download, content,
verify-access) calls the function and repeats it inside its view-count UPDATE;
no server-key share can be stored at master key version 0; the
`team-permissions` move keeps every route on `team-auth`; no route lets a MEMBER
write another member's entry.

## Testing Findings
- T1 [Major] The seeder had no automated check.
- T2 [Major] The card's `canEdit` → inline `onEdit` and the pane's `onEdit` →
  inline hops were untested, so history restore and upload gating could regress
  green.
- T3 [Minor] The `permissions.canEdit` intersection in the list view was untested.
- T4 [Minor] A14 did not check the content route for personal shares.
- T5 [Minor] The download route was never exercised against the real function.
- T6 [Minor] The MinIO "is refused" cell accepted any error.
- T7 [Minor] Unreset captured callbacks, an in-body env restore, and an
  unstubbed ambient env in changed tests.

## Adjacent Findings
- (Security → Functionality) Share creation on a trashed entry — merged into F6.
- F8 [Minor] The seeder validates the HMAC key on its own `session-cache`
  instance while the E2E helpers hash on theirs.
- (Testing) Serve-path comments — merged into F4.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3/R42: F1 (Watchtower was a missed member of the team-entry edit entry points:
team list, accordion card, detail pane, Watchtower). R6/R41: F2. R29: F4, F5.
R34: F3, F6. Others OK or N/A (R12 all three ShareType values covered; R14 grant
kept; R48 one `canWriteTeamEntry` for server and client).

### Security expert
R1–R57 and RS1–RS6 OK or N/A. R2 the five-table pin in the migration and the
verify script; R42 writer member-set of `password_shares` / `master_key_version`
derived from code; R43 no boundary widened; R52 the widened function re-audited;
R55 version 0 cannot collide with a server-key version (≥ 1 enforced).

### Testing expert
R16: T6. R19/RT1: T2. R35/R41/RT6: T1. R42: T2. RT7: T3, T6. RT10: T3. Others OK
or N/A.

Seed dispositions: testing seed 1 (env leak in the MinIO cell) rejected — the
describe already has `afterEach(vi.unstubAllEnvs)`; seed 2 adopted as T3;
seed 3 rejected — the locked link is admitted under both policies.

## Environment Verification Report
- #960 seeder: verified-local — `seed-load-test-users.mjs --smoke` against the
  dev server (seed → `GET /api/passwords` 200 → cleanup), and
  `npm run test:integration -- load-test-seeder` (3 cells).
- #1013: verified-local — MinIO cells with `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000`.
- Share admission, #997: verified-local — `share-departure`,
  `master-key-rotation-races` integration suites.

## Resolution Status
### F1 [Major] Watchtower team edit ignored the MEMBER own-entry rule
- Action: team Watchtower refs carry `createdById` (from the list's `createdBy`);
  the server page passes the viewer's `teamRole`; `WatchtowerPage` computes
  `canEditEntry` with `canWriteTeamEntry`, disables the open action per entry
  (`canSelectEntry` on IssueSection / ReusedSection / DuplicateSection) and
  renders the team dialog only for an editable entry. Unknown role, user or
  creator → not editable.
- Modified: `src/hooks/use-watchtower.ts`, `src/components/watchtower/{watchtower-page,issue-section}.tsx`,
  `src/app/[locale]/dashboard/teams/[teamId]/watchtower/page.tsx`; tests in
  `watchtower-page.test.tsx` (OWNER/ADMIN any, MEMBER own → open; MEMBER other,
  no role, no user, no creator → not), `issue-section.test.tsx`,
  `duplicate-section.test.tsx`, `use-watchtower.test.ts`.
- Red proof: gate forced true → 4 cells fail.

### F2 [Major] Seeder cleanup blocked by tenant audit rows
- Action: cleanup deletes the tenant's `audit_outbox`, then `audit_logs`, then
  `audit_chain_anchors` before the user rows and again before the tenant (the
  outbox delete waits for an in-flight drain). README manual SQL reordered to
  match and extended with `audit_logs` / `audit_chain_anchors`; every statement
  run once against the dev DB.
- Modified: `load-test/setup/seed-load-test-users.mjs`, `load-test/README.md`.
- Test: `load-test-seeder.integration.test.ts` "cleanup removes … including audit
  rows a worker wrote for the tenant".

### T1 [Major] Seeder had no automated check
- Action: `src/__tests__/db-integration/load-test-seeder.integration.test.ts`
  runs the seeder CLI in a child process: the cookie's digest resolves to a live
  session of an active member of the load-test tenant; a re-seed keeps the id,
  replaces the session and reactivates a deactivated membership; cleanup removes
  users, sessions, memberships, audit rows, the tenant and the credentials file.
  Refuses to run over an existing developer seed. `ci-integration.yml` now
  triggers on `load-test/setup/**` and `e2e/helpers/db.ts`.
- Importing the seeder's functions into vitest was tried first and dropped:
  `tsImport` of the app modules inside vitest fails in pino's initialisation.

### T2 [Major] Card / pane onEdit hops untested
- Action: inline stubs in `password-card.test.tsx` and
  `password-detail-pane.test.tsx` expose whether `onEdit` arrived; cells for
  card `canEdit` true/false and pane `onEdit` present/absent.
- Red proof: card passing `onEdit` unconditionally → 1 cell fails.

### F3 [Minor] Attachment delete shown to MEMBER
- Action: `TeamAttachmentSection` shows delete only when the active team vault's
  role holds PASSWORD_DELETE (unknown → hidden); upload unchanged. Cells for
  OWNER, ADMIN, MEMBER, another team's OWNER, no vault.
- Red proof: back to `!readOnly` → 3 cells fail.

### F4 [Minor] Stale serve-path comments
- Action: comments in `s/[token]/page.tsx`, `s/[token]/download/route.ts`,
  `share-links/[id]/content/route.ts`, `share-links/verify-access/route.ts`
  name all refusal reasons.

### F5 [Minor] policy-enforcement.md creation-only rows
- Action: both rows name the serve-time enforcement and its reversibility.

### F6 [Minor] Share creation on a trashed entry
- Action: both branches of `POST /api/share-links` select `deletedAt` and answer
  404 for a trashed entry; cell pairs trashed → 404 with no row and live → 201
  for personal and team.
- Red proof: each branch's check removed → its cell fails.

### F7 [Minor] Ragged description wrap
- Action: description joined with spaces; the generator wraps it; `.env.example`
  regenerated; `check:env-docs` passes.

### F8 [Minor] Two session-cache instances in the seeder
- Anti-Deferral check: no change needed.
- Justification: `validateSessionTokenHmacKey` and `hashSessionToken` read the
  same process environment, so validating on one instance still fails before the
  first row whenever the other would hash with a missing or invalid key; the
  integration test proves the stored digest equals the app's `hashSessionToken`
  of the cookie token.

### T3 [Minor] canEdit intersection
- Action: cell with `permissions.canEdit=false` and `canWriteEntry → true`
  asserts no card `canEdit` and no pane edit / archive.
- Red proof: intersection dropped → the cell fails.

### T4 [Minor] Content route for personal shares
- Action: A14 seeds server-key-encrypted personal shares; content 200 before,
  equal to the revoked control after trash/delete, 200 again after restore.

### T5 [Minor] Download route against the real function
- Action: A13 adds a protected team FILE share: download is 410 while sharing is
  off, and returns the admitted status again when sharing is back on.

### T6 [Minor] MinIO refusal accepted any error
- Action: the cell accepts only `ENOTFOUND <bucket>.localhost` or
  `NoSuchBucket` (observed locally: `NoSuchBucket`).

### T7 [Minor] Test hygiene
- Action: captured pane callbacks reset in `beforeEach`; `vaultUser` reset in
  `beforeEach`; `S3_FORCE_PATH_STYLE` stubbed to `""` in the default cell.
