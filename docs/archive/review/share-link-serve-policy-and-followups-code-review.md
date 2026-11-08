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

## Round 2

Incremental review of `0c90d2039`. F1, F3–F7 resolved; F2 partly (below).

### Findings
- Functionality F2-1 [Major] `audit_outbox` refuses to delete a row that is not
  SENT or FAILED (trigger `audit_outbox_before_delete_guard`), so cleanup failed
  right after a run whose events were still PENDING/PROCESSING; the JSDoc's claim
  that the delete waits for a draining worker was wrong; README SQL the same.
- Functionality F2-2 [Minor] `ActiveVaultProvider.setVault` kept the previous
  team object when the teamId matched, so a role change within the team never
  reached the attachment delete gate (also raised by Testing as Adjacent).
- Security S-R2-1 [Minor, Adjacent] the seeder's invalid-URL error echoed the
  whole `DATABASE_URL` (password), now piped into CI logs by the new test.
- Testing T8 [Major] `ci-integration.yml` did not trigger on `src/app/s/**`,
  `src/lib/share/**`, `src/components/share/**`, which share-departure tests.
- Testing T9 [Minor] the Watchtower page test pinned the gate on 2 of 7 sections
  and could not reach the dialog render guard.
- Testing T10 [Minor] A13 asserted the admitted download as "not 410" and never
  reached the download's view-count UPDATE recheck.
- Testing T11 [Minor] the seeder test's `execFileSync` had no timeout and the
  integration job no `timeout-minutes`.
- Testing T12 [Minor] a broken seeder cleanup would leave rows that make later
  runs refuse; no red proof for the seeder cells.

### Resolution Status
#### F2-1 [Major] Cleanup fails on undrained outbox rows
- Action: `deleteTenantAudit` waits (1 s poll, `LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS`,
  default 60 s) until the tenant has no outbox row outside SENT/FAILED, then
  deletes; otherwise it throws `LOAD_TEST_CLEANUP_OUTBOX_UNDRAINED` naming the
  count and the worker command. The trigger stays the boundary (no status
  rewrite). JSDoc corrected; README explains the wait and the refusal; the CLI
  labels a cleanup failure as such.
- Tests: "cleanup refuses by name, deleting nothing, while an outbox row of the
  tenant stays PENDING" (deny) and "cleanup waits for a PENDING outbox row the
  worker delivers, then completes" (allow).
- Red proof (scratch copy of the seeder, real DB): M10 drain wait removed →
  3 cells fail.

#### F2-2 [Minor] Stale team role in the active vault
- Action: `setVault` keeps the previous object only when every field matches;
  the old "same team, renamed" identity cell now asserts replacement, with a
  role-change cell.

#### S-R2-1 [Minor] Connection string in an error message
- Action: the reason no longer includes the URL.

#### T8 [Major] CI trigger paths
- Action: the three share paths added to `ci-integration.yml`.

#### T9 [Minor] Watchtower gate on every section, render guard
- Action: the page test captures each section's `canSelectEntry` (all seven) and
  checks it per entry; a cell selects past the disabled state and asserts no
  dialog for another member's entry, with the own-entry control opening it.
- Red proof: render guard removed → 1 fail; ReusedSection gate removed → 1 fail.

#### T10 [Minor] Download assertions
- Action: admitted download pinned to 401; new cell with the pre-check forced:
  the download's UPDATE refuses while sharing is off (410, no view counted) and
  counts the view once it is on.

#### T11 [Minor] Timeouts
- Action: every seeder child runs with a 60 s timeout; the integration job has
  `timeout-minutes: 30` (runs take about 6 minutes).

#### T12 [Minor] Residue after a broken cleanup; red proof
- Action: `afterAll` removes whatever the seeder left (its outbox fixtures marked
  FAILED first) and the credentials file.
- Red proof (scratch copy, real DB): M7 tenant `audit_logs` delete removed →
  cleanup cell fails; M8 membership reactivation removed → re-seed cell fails;
  M9 session replacement removed → re-seed cell fails; the fallback left no
  tenant behind.

## Round 3

Incremental review of `8047af0d5`. Round 2 findings resolved; new findings
below are all within that fix scope.

### Findings
- Functionality F3-1 [Minor] A non-numeric `LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS`
  made the drain wait never expire (NaN deadline); an empty value refused at once.
- Functionality F3-2 [Minor] The refusal message blamed a stopped worker, while a
  running worker's retry backoff also keeps rows PENDING.
- Functionality F3-3 [Minor] The drain wait runs twice on the users path.
- Security S-R3-1 [Minor] / Testing F3-T1 [Major] vitest runs `afterAll` after a
  refusing `beforeAll`, so the seeder test's fallback would wipe a developer's
  existing seed, including marking its undrained outbox rows FAILED.
- Security [Adjacent] The seeder deleted `audit_logs` by actor across tenants.
- Testing F3-T2 [Minor] The drain-wait cell synchronised on a fixed sleep.
- Testing F3-T3 [Minor] A failing refusal cell left its PENDING row, and
  afterEach's 60 s drain equalled the child timeout.
- Testing F3-T4 [Minor] `tenantName` / `isCrossTenant` in the vault compare were
  unpinned.
- Testing F3-T5 [Minor] The forced-precheck download's admitted status was
  unasserted; the cell name said "twin".

### Resolution Status
- F3-1: the value is parsed once; unset or empty → 60 000; anything not a finite
  non-negative number throws a named error.
- F3-2: the message and the README name both cases (start the worker; or wait /
  raise the timeout when it is retrying).
- F3-3: no change needed (Anti-Deferral: worst case is a second wait whose
  refusal leaves only the tenant row, removed by re-running cleanup, which then
  takes the no-users branch; cost to restructure exceeds the benefit).
- S-R3-1 / F3-T1: the fallback runs only once `beforeAll` has found no prior
  seed (`ownsSeedState`), afterEach likewise, and FAILED is set only on this
  suite's own fixture rows (`createdOutboxIds`). Proof: a seed created by hand,
  then the suite → `LOAD_TEST_SEEDER_TEST_REFUSED`, 5 skipped, the user and the
  credentials file still present; removed afterwards with `--cleanup`.
- Adjacent: the actor-keyed `audit_logs` delete was removed from the seeder;
  audit rows are deleted only by the load-test tenant.
- F3-T2: the cell waits for the seeder's "Cleaning up 1 load test users" line,
  then for one poll interval, asserts the child is still running, delivers the
  row, and asserts exit 0; the row is delivered in `finally`.
- F3-T3: `markSent` in `finally`; afterEach cleanup uses a 5 s drain timeout.
- F3-T4: rows for tenant name and cross-tenant flag added.
- F3-T5: the admitted download is asserted (404: the fixture stores no file,
  answered after the UPDATE counted the view); cell renamed.

## Round 4

Incremental review of `5818cb911`. Security: no findings (S-R3-1 confirmed
closed). Round 3 findings resolved.

### Findings and resolution
- Functionality F4-1 [Minor] A whitespace-only drain timeout parsed as 0 ms.
  Action: the value is trimmed before the unset check.
- Security [Adjacent] Cleanup selected users by the email pattern in every
  tenant. Action: it selects only the load-test tenant's users.
- Testing T4-1 [Minor] The drain-timeout validation had no test. Action:
  `--cleanup` with `"abc"` and `"-1"` must refuse by name. Red proof (scratch
  seeder, real DB): validation removed → both cells fail. The unset/empty → 60 s
  branch stays untested: telling it apart needs a pending row and a full wait.
- Testing T4-2 [Minor] The drain-wait cell's child timeout (60 s) exceeded the
  30 s test timeout. Action: 25 s (above the 20 s drain), the child is killed in
  `finally` if still running, and the stdout chunk is typed as a string.
