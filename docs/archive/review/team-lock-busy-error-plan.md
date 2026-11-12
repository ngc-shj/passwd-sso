# Plan: team-lock-busy-error

Issue: `#1021` — answer a bounded team-lock timeout with a dedicated `TEAM_BUSY` error, not
`TEAM_KEY_VERSION_MISMATCH`.

## Project context

- Type: web app (Next.js API routes + React client), plus browser extension / iOS / CLI clients.
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: the lock-timeout cell needs a second connection holding the `teams` row past
    `TEAM_KEY_LOCK_TIMEOUT_MS` (3 s). The integration suite has this harness
    (`withRotationStandIn` in `team-key-version-guard.integration.test.ts`) — `verifiable-local`
    and `verifiable-CI`.
  - No `blocked-deferred` paths.

## Objective

When a writer's bounded wait for a `teams` row lock runs out, the client is told "busy, retry
shortly" with a `Retry-After` hint — not `TEAM_KEY_VERSION_MISMATCH`, which tells it to re-fetch
the team key and which the re-key runner answers by invalidating its cached team keys. A genuine
version mismatch keeps answering `TEAM_KEY_VERSION_MISMATCH`.

## Background (state on main, `3cd74d3f5`)

`withBoundedLockWait` (`src/lib/team/team-key-rotation-lock.ts`) throws
`TeamRotationInProgressError` by default on SQLSTATE `55P03`/`57014`; `tenant-row-lock.ts` passes
`TenantMemberLockTimeoutError` for its tenant-row and advisory-lock waits. Two caller families:

- **Entry family** — maps `TeamRotationInProgressError` to `TEAM_KEY_VERSION_MISMATCH` (the
  defect). Derivation:
  `rg -n "TeamRotationInProgressError" src --glob '!**/*.test.ts' --glob '!**/__tests__/**'`
  minus the defining file and `team-attachment-lock.ts` (doc only) — 7 sites, re-derived by all
  three plan reviewers:
  1. `src/lib/services/team-password-service.ts` `assertCurrentTeamKeyVersion`, reached by entry
     POST, PUT (incl. the re-key runner's v0→v1 upgrade PUT) and bulk import.
  2. `.../passwords/[id]/attachments/route.ts` (upload).
  3. `.../attachments/[attachmentId]/route.ts` (delete).
  4. `.../attachments/[attachmentId]/migrate/route.ts`.
  5. `.../passwords/[id]/rekey/route.ts`.
  6. `.../passwords/[id]/history/[historyId]/restore/route.ts`.
  7. `.../members/[memberId]/confirm-key/route.ts` (sets `version_mismatch`).
- **Membership family** — `isMembershipLockConflict(e)` (`tenant-row-lock.ts`) lumps
  `TeamRotationInProgressError`, `TeamRotationLockError`, `TenantMemberLockTimeoutError`, deadlock
  (`40P01`) and `P2028`; routes answer `API_ERROR.CONFLICT`. Derivation:
  `rg -n "isMembershipLockConflict\(" src/app --glob '!**/*.test.ts'` — non-SCIM:
  `teams/route.ts`, `teams/invitations/accept`, `teams/[teamId]/invitations`,
  `teams/[teamId]/members`, `members/[memberId]` (3), `members/[memberId]/approve`,
  `members/[memberId]/reject`, `tenant/teams/[teamId]/owner`, `tenant/members/[userId]`; SCIM:
  `scim/v2/Users`, `Users/[id]` (3), `Groups/[id]` (2). `isTeamRotationConflict(e)` → `CONFLICT`
  in `vault/reset` and `vault/admin-reset`.

## Requirements

- R1: A `TeamRotationInProgressError` (a `teams`-row wait that ran out) answers
  `409 { error: "TEAM_BUSY" }` + `Retry-After` on every route above except SCIM (SC1) and
  `vault/admin-reset` (SC5).
- R2: A genuine key-version mismatch keeps answering `TEAM_KEY_VERSION_MISMATCH`.
- R3: Every other membership conflict (`TenantMemberLockTimeoutError`, `TeamRotationLockError`,
  deadlock, `P2028`) keeps answering `CONFLICT` (SC2).
- R4: Every web-client consumer of an affected route treats `TEAM_BUSY` as wait-and-retry
  (automated passes) or shows a retry-shortly message (interactive) — never a key refresh, never a
  misleading state message.
- R5: en/ja i18n for `TEAM_BUSY` and the new form message.

## Technical approach

One new code and one response helper. Each route keeps its own catch and maps the timeout through
the helper, so `Retry-After` cannot be dropped at a site. No lock, isolation or transaction
behaviour changes: only the answer to an already-aborted wait.

**409, not 503.** The refusal concerns the target's current state (another transaction holds the
team row), not service availability; 503s feed availability alarms. RFC 9110 §10.2.3 defines
`Retry-After` as a response field with specific meaning for 503 and 3xx, not restricted to them.
Clients must key off the code, not the status (C5 fixes the ones that key off 409).

**Why only `TeamRotationInProgressError`.** It is the one timeout the issue names and the one
whose wording ("another change to a team") is accurate at every site. The tenant-row timeout
already reaches clients as `CONFLICT`, some of which word it ("approvalBusyRetry"); folding it in
would mislabel a tenant-role change as team activity (review S-F3, F-F3).

## Contracts

### C1 — error code, status, i18n

- `API_ERROR.TEAM_BUSY`; `API_ERROR_STATUS.TEAM_BUSY = 409`; i18n key `teamBusy`;
  `messages/{en,ja}/ApiErrors.json`:
  en "Another change to a team is in progress. Please try again in a moment." /
  ja "チームで別の変更が進行中です。少し待ってから再度お試しください。"
- `src/lib/http/api-error-codes.test.ts` key-count assertion 204 → 205 with its justification line.
- Invariant: schema-enforced by the `satisfies Record<ApiErrorCode, …>` maps + the i18n coverage
  test.

### C2 — response helper

- `teamBusy(): NextResponse` in `src/lib/http/api-response.ts`, beside `rateLimited`: 409
  `TEAM_BUSY` with `Retry-After` = `ceil(TEAM_BUSY_RETRY_AFTER_MS / 1000)`.
- `TEAM_BUSY_RETRY_AFTER_MS = TEAM_KEY_LOCK_TIMEOUT_MS` in `src/lib/constants/team/rotate-key.ts`
  (a waiter that just spent the budget should not retry sooner than one budget).

### C3 — entry family

- `assertCurrentTeamKeyVersion`: `TeamRotationInProgressError` →
  `TeamPasswordServiceError(API_ERROR.TEAM_BUSY, 409)`. Entry POST and PUT answer `teamBusy()` for
  that code; other codes unchanged.
- Bulk import: `TEAM_BUSY` is rethrown out of the per-entry savepoint and the transaction exactly
  as a mismatch is (the predicate widens to both codes), answering `teamBusy()`. Why: a timeout
  can only occur before the transaction holds the team row (first entry, or the entry after a
  savepoint rollback released it); counting it as a per-entry failure would let the import commit
  some entries while reporting the rest failed for a transient reason, and the next entry would
  wait again.
- Routes 2–6: the timeout arm yields `TEAM_BUSY` → `teamBusy()`.
- confirm-key: new `busy` outcome → `teamBusy()`; the version comparison (`version_mismatch`) is
  unchanged.
- Acceptance: per site, a timeout cell answers 409 `TEAM_BUSY` + `Retry-After: "3"` and writes and
  audits nothing; a genuine-mismatch cell still answers `TEAM_KEY_VERSION_MISMATCH`. After the
  change no `TeamRotationInProgressError` arm in `src/app`/`src/lib/services` yields
  `TEAM_KEY_VERSION_MISMATCH` (Phase 2/3 reads each of the 7 arms; confirm-key is pinned by its
  `busy` test, since its mismatch answer is set indirectly).

### C4 — membership family and vault reset

- `isTeamLockTimeout(e): e is TeamRotationInProgressError` in `team-key-rotation-lock.ts`.
- `membershipConflictResponse(e): NextResponse` in `tenant-row-lock.ts`:
  `isTeamLockTimeout(e) ? teamBusy() : errorResponse(API_ERROR.CONFLICT)`. Every non-SCIM
  `isMembershipLockConflict` site returns it in place of `errorResponse(CONFLICT)`.
- `vault/reset`: `isTeamLockTimeout(e) ? teamBusy() : errorResponse(CONFLICT)` for
  `isTeamRotationConflict(e)`.
- `isMembershipLockConflict` / `isTeamRotationConflict` keep their meaning (SCIM uses the former).
- Accepted (review S-F1, S-F2): the lock precedes the in-transaction actor re-check in some routes,
  so a member demoted after `requireTeamPermission` can see `TEAM_BUSY` for up to 3 s; the retry
  then answers 403. Pre-transaction authorization still runs first, so an unauthorized principal
  never sees it. `TEAM_BUSY` names no team; the routes add no team id to the body.

### C5 — web client

Member set derivation (recorded with output in the deviation log at Phase 2):
`rg -n "apiPath\.(teamPasswords|teamPasswordById|teamPasswordsBulkImport|teamPasswordAttachments|teamPasswordAttachmentById|teamPasswordAttachmentMigrate|teamPasswordRekey|teamPasswordHistoryRestore|teamMemberConfirmKey|teamMembers|teamMemberById|teamMemberApprove|teamMemberReject|teamInvitations|teamInvitationAccept|teams\b|tenantMemberById|tenantTeamOwner|vaultReset)" src --glob '!**/*.test.*' --glob '!src/app/api/**'`
(exact `apiPath` names fixed against `src/lib/constants/auth/api-path.ts` when run). Known
members and their change:

- `src/lib/team/rekey-runner.ts`: `TEAM_BUSY` → new `REKEY_ACTION.BUSY_WAIT` in `ACTION_BY_CODE`,
  and a `BUSY_WAIT` arm in every chain that consumes `classifyRekeyResponse` for a locking request:
  the upgrade PUT, the migrate PUT (`migrateRefusal`), the re-key POST. (The re-key GET and the
  migrate download GET take no lock.) `BUSY_WAIT`: sleep `min(retryAfterMs(res),
  REKEY_BUSY_MAX_WAIT_MS)` with `REKEY_BUSY_MAX_WAIT_MS = 30 s`, retry the same request, count
  against `MAX_ROTATION_WAITS`, never call `invalidateTeamKeys`. Update the `refreshKeys` comment
  and `Teams.rekeyStopRetryBudget` (en/ja) to name a busy team.
- `src/components/team/forms/team-entry-submit.ts` `saveErrorMessage`: `TEAM_BUSY` → new
  `PasswordForm.teamEntryTeamBusy` (en/ja).
- `src/components/passwords/import/password-import-importer.ts`: a 409 with `TEAM_BUSY` is retried
  in the same loop as 429 (same `Retry-After` clamp, same `MAX_RETRIES_PER_CHUNK` = 2 retries).
  Other 409s are not retried. A rotation outlasting ~6 s still fails the chunk, as a 429 storm does.
- `src/components/team/forms/team-attachment-section.tsx` delete: `toastApiError(res, tApi)` instead
  of the fixed `deleteError` — deliberately for every API error, as upload already does; network
  errors keep `deleteError`.
- `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx` approve/reject: `TEAM_BUSY` →
  `approvalBusyRetry` (same meaning as today's `CONFLICT`).
- `src/components/team/management/ownerless-teams-card.tsx`: `TEAM_BUSY` → `tApi("teamBusy")` and
  refresh, as `CONFLICT` does.
- Status-keyed consumers (any 409 → one fixed state message) — they misreport `CONFLICT` today
  and would misreport `TEAM_BUSY`: `team-invite-by-email-section.tsx` (`alreadyInvited`),
  `team-add-from-tenant-section.tsx` (`alreadyMember` fallback), `team-create-dialog.tsx`
  (`slugTaken`), `tenant-members-card.tsx` (`scimManagedRoleError`). Each keys its fixed message
  on the code its route returns for that state (read from the route in Phase 2) and renders
  `tApi(apiErrorToI18nKey(code))` for any other 409.
- No change, confirmed: history restore and attachment upload already render
  `tApi(apiErrorToI18nKey(code))`; `team-vault-core.tsx` confirm-key distribution swallows errors
  and retries on the next poll; `team-rotate-key-button.tsx` (rotation takes no bounded wait).
- Extension, iOS, CLI: no team writer (`rg -n "/teams/" extension/src cli/src ios --glob
  '!**/*test*'` shows reads only) and no `API_ERROR` list.
- Consumer walkthroughs: runner reads `{ error, Retry-After }` (code → action, header → sleep);
  importer reads `{ status, error, Retry-After }`; form/page/card consumers read `{ error }` → a
  message key.

### C6 — docs

`docs/api/error-handling.md`: the `Retry-After` header table row, the invariants bullet, and the
409 status-table row gain `TEAM_BUSY` / `teamBusy()`. Reword the stale "directory sync fails the
run" doc comment on `isMembershipLockConflict` (directory sync reaches the lock through
`team-departure.ts` and fails on the thrown error, not through this helper).

## Forbidden patterns

- pattern: `errorResponse\(API_ERROR\.TEAM_BUSY` outside `src/lib/http/api-response.ts` — reason:
  bypasses `teamBusy()` and drops `Retry-After`.

## Testing strategy

Every flipped or new cell asserts the code, `Retry-After` (present for `TEAM_BUSY`, absent for
`CONFLICT`), and that no write or audit mock was called. Each is red-proved against the old mapping
on a scratchpad copy (RT7), never in place.

- Shared: `api-error-codes.test.ts` (count, 409, `teamBusy`); `api-response.test.ts` `teamBusy()`
  (409, `Retry-After: "3"`); `tenant-row-lock.test.ts` `membershipConflictResponse` over all five
  kinds (one → `TEAM_BUSY`, four → `CONFLICT`); `isTeamLockTimeout`.
- Entry family — flip: `team-password-service.test.ts` (timeout cell, `55P03` through the real
  helper), `rekey/route.test.ts`, `attachments/route.test.ts`, `attachments/[attachmentId]/route.test.ts`,
  `migrate/route.test.ts`, `confirm-key/route.test.ts` (timeout cell; mismatch cell stays). Add:
  history restore timeout + mismatch cells; entry POST/PUT route `TEAM_BUSY` → `teamBusy()` cells;
  bulk import `TEAM_BUSY` abort cell (precondition: first entry times out; asserts no further
  service call, no audit, 409 `TEAM_BUSY`), mismatch cell stays. `team-entry-rekey.test.ts` stubs
  the error class: use the real class via `importActual` so `isTeamLockTimeout` sees the same
  identity.
- Membership family — per non-SCIM site: tighten existing timeout cells (bare 409 or `CONFLICT`) to
  `TEAM_BUSY`, and add a paired `TeamRotationLockError` or `TenantMemberLockTimeoutError` →
  `CONFLICT` cell; add both cells where none exists (`teams/route.ts`, `teams/[teamId]/invitations`,
  `tenant/teams/[teamId]/owner`). `approve`/`reject` existing `TeamRotationLockError` cells stay
  `CONFLICT` and gain a `TEAM_BUSY` timeout cell. `vault/reset`: timeout → `TEAM_BUSY`, lock error →
  `CONFLICT`; `vault/admin-reset`: timeout → `CONFLICT` (SC5).
- Integration (`team-key-version-guard.integration.test.ts`, real lock): flip the create timeout
  cell and the member-removal timeout cell to `TEAM_BUSY` + `Retry-After`; add PUT, bulk-import and
  confirm-key timeout cells on `withRotationStandIn`; parked-rotation cells (genuine mismatch after
  the wait) stay `TEAM_KEY_VERSION_MISMATCH`. Widen the `waitedMs` upper bound only if a CI run
  shows it flaking.
- Client: `rekey-runner.test.ts` — `TEAM_BUSY` on each of upgrade PUT, migrate PUT, re-key POST →
  sleeps the clamped `Retry-After`, retries, `invalidateTeamKeys` not called; budget exhaustion
  stops with `RETRY_BUDGET_EXHAUSTED`; `TEAM_BUSY` then genuine mismatch → `REFRESH_KEYS`.
  `password-import-importer.test.ts` — 409 `TEAM_BUSY` retried, other 409 not.
  `team-entry-submit.test.ts` table row. `team-attachment-section.test.tsx` delete → `toastApiError`.
  Members-list page, ownerless card and the four status-keyed consumers: `TEAM_BUSY` cell plus
  their fixed-message cell keyed on the specific code.

## Considerations & constraints

### Scope contract

- SC1: SCIM routes keep `scimError(409, membershipConflictMessage(e))`; SCIM clients read the SCIM
  envelope, and the message already says "retry later".
- SC2: `TenantMemberLockTimeoutError`, `TeamRotationLockError`, deadlock and `P2028` keep
  `CONFLICT`. Retry-safe too, but not a team-row wait; a dedicated code for them is a separate
  decision about `CONFLICT`.
- SC3: No CI gate for C3's invariant; the 7-site class is closed here and recorded by command.
- SC4: Rotation takes `FOR NO KEY UPDATE` without a bounded wait and the retention-GC prune uses
  `SKIP LOCKED`; neither produces this timeout.
- SC5: `vault/admin-reset` keeps `CONFLICT`: its token is spent before the transaction, so "try
  again in a moment" would mislead — the reset must be initiated again (route comment).

### Risks

- Fixed `Retry-After` without jitter: waiting writers retry together after a rotation. Bounded by
  the client budgets; the server re-reads the version under `FOR SHARE` on every retry, so a stale
  key is never accepted.

## User operation scenarios

1. Owner rotates a large team's key; a member saves an entry during it → after ~3 s,
   `teamEntryTeamBusy`; retrying after the rotation answers a mismatch and the form's existing
   key-changed path applies.
2. Admin runs the re-key pass while the retention GC prunes old team keys → a re-key POST times out
   → runner waits 3 s and retries with its cached keys.
3. Admin approves a SCIM-pending member during a rotation → `approvalBusyRetry`, as for any busy
   conflict today.
4. CSV import into a team during a rotation → the chunk is retried after `Retry-After`.
5. Admin invites a member during a rotation → "another change in progress", not "Invitation
   already sent".

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `TEAM_BUSY` code, 409, i18n | locked |
| C2 | `teamBusy()` + `Retry-After` constant | locked |
| C3 | entry family timeout → `TEAM_BUSY` | locked |
| C4 | membership family / vault reset team-lock timeout → `TEAM_BUSY` | locked |
| C5 | web client handling | locked |
| C6 | docs | locked |
