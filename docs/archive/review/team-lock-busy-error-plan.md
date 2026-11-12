# Plan: team-lock-busy-error

Issue: `#1021` — answer a bounded team-lock timeout with a dedicated `TEAM_BUSY` error, not
`TEAM_KEY_VERSION_MISMATCH`.

## Project context

- Type: web app (Next.js API routes + React client), plus browser extension / iOS / CLI clients.
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - VE1: the lock-timeout cell needs a second connection holding the `teams` row past
    `TEAM_KEY_LOCK_TIMEOUT_MS` (3 s). The integration suite already has this harness
    (`withRotationStandIn` in `team-key-version-guard.integration.test.ts`) — `verifiable-local`
    and `verifiable-CI`.
  - No `blocked-deferred` paths.

## Objective

When a team writer's bounded wait for a `teams` row lock (`withBoundedLockWait`,
`TEAM_KEY_LOCK_TIMEOUT_MS`) runs out, the client is told "busy, retry shortly" with a
`Retry-After` hint — not `TEAM_KEY_VERSION_MISMATCH`, which tells it to re-fetch the team key and
which the re-key runner answers by invalidating its cached team keys. A genuine version mismatch
keeps answering `TEAM_KEY_VERSION_MISMATCH`.

## Background (state on main, `3cd74d3f5`)

`withBoundedLockWait` (`src/lib/team/team-key-rotation-lock.ts`) throws
`TeamRotationInProgressError` by default on SQLSTATE `55P03`/`57014`, or `timeoutError()` when a
caller passes one (`tenant-row-lock.ts` passes `TenantMemberLockTimeoutError`). The callers fall
into two families, which map the timeout differently today:

- **Entry family** — maps `TeamRotationInProgressError` to `TEAM_KEY_VERSION_MISMATCH` (the
  defect). Member set derived by:
  `rg -n "TeamRotationInProgressError" src --glob '!**/*.test.ts' --glob '!**/__tests__/**'`
  (excluding the defining file and `team-attachment-lock.ts`, which only documents the throw):
  1. `src/lib/services/team-password-service.ts` `assertCurrentTeamKeyVersion` — reached by
     team entry POST, PUT and bulk import (`src/app/api/teams/[teamId]/passwords/route.ts`,
     `.../passwords/[id]/route.ts`, `.../passwords/bulk-import/route.ts`).
  2. `.../passwords/[id]/attachments/route.ts` (upload).
  3. `.../passwords/[id]/attachments/[attachmentId]/route.ts` (delete).
  4. `.../passwords/[id]/attachments/[attachmentId]/migrate/route.ts`.
  5. `.../passwords/[id]/rekey/route.ts`.
  6. `.../passwords/[id]/history/[historyId]/restore/route.ts`.
  7. `.../members/[memberId]/confirm-key/route.ts` (sets `version_mismatch`).
- **Membership family** — `isMembershipLockConflict(e)` (`src/lib/team/tenant-row-lock.ts`) lumps
  `TeamRotationInProgressError`, `TeamRotationLockError`, `TenantMemberLockTimeoutError`, a
  deadlock (`40P01`) and an expired Prisma transaction (`P2028`), and routes answer
  `API_ERROR.CONFLICT` ("The resource has already been modified"). Member set:
  `rg -n "isMembershipLockConflict\(" src/app --glob '!**/*.test.ts'` — `teams/route.ts`,
  `teams/invitations/accept`, `teams/[teamId]/invitations`, `teams/[teamId]/members`,
  `members/[memberId]` (3 sites), `members/[memberId]/approve`, `members/[memberId]/reject`,
  `tenant/teams/[teamId]/owner`, `tenant/members/[userId]`, and the SCIM routes
  (`scim/v2/Users`, `Users/[id]` ×3, `Groups/[id]` ×2), which answer `scimError(409, message)`.
  `isTeamRotationConflict(e)` → `CONFLICT` additionally in `vault/reset` and `vault/admin-reset`.

## Requirements

- R1: A bounded lock wait that ran out answers `409 { error: "TEAM_BUSY" }` with a `Retry-After`
  header, on every non-SCIM route above.
- R2: A genuine key-version mismatch (row read after the wait, version differs, or the team row
  invisible where the route answers mismatch today) keeps answering `TEAM_KEY_VERSION_MISMATCH`.
- R3: The other membership conflicts (`TeamRotationLockError`, deadlock, `P2028`) keep answering
  `CONFLICT` (SC2).
- R4: Web clients that act on the code treat `TEAM_BUSY` as "wait and retry" (automated passes)
  or show a retry-shortly message (interactive saves) — never as a key refresh.
- R5: en/ja i18n message for `TEAM_BUSY`.

## Technical approach

One new error code and one response helper; each route keeps its own catch but maps the timeout
through the helper, so `Retry-After` cannot be forgotten at a site. No lock, isolation or
transaction behaviour changes — only the answer to an already-aborted wait.

### Why 409 (not 503)

The refusal is about the target resource's current state (another transaction holds the team
row), not service availability; 503s feed availability alarms and the `serviceUnavailable()`
envelope's operator semantics. `Retry-After` on a 409 is permitted (RFC 9110 §10.2.3 allows it on
any response; it is defined for 503 and 3xx but not restricted to them). Status is part of the
code's single mapping in `API_ERROR_STATUS`, so clients key off the code, not the status.

## Contracts

### C1 — error code, status, i18n key

- `API_ERROR.TEAM_BUSY = "TEAM_BUSY"`; `API_ERROR_STATUS.TEAM_BUSY = 409`;
  i18n key `teamBusy` in the code→key map; `messages/{en,ja}/ApiErrors.json` `teamBusy`:
  en "Another change to this team is in progress. Please try again in a moment." /
  ja "このチームで別の処理が進行中です。少し待ってから再度お試しください。"
  (Same wording serves the tenant-member lock timeout of C4: those routes are team-membership
  operations.)
- Invariants: every exhaustive map / i18n coverage test over `API_ERROR` passes (schema-enforced
  by the `Record<ApiErrorCode, …>` types + existing i18n coverage test).

### C2 — response helper

- `teamBusy(): NextResponse` in `src/lib/http/api-response.ts`, beside `rateLimited`:
  `errorResponse(API_ERROR.TEAM_BUSY, undefined, undefined, { "Retry-After": <seconds> })`.
- `TEAM_BUSY_RETRY_AFTER_MS` in `src/lib/constants/team/rotate-key.ts`, defined as
  `TEAM_KEY_LOCK_TIMEOUT_MS` (a waiter that just spent the full budget should not retry sooner
  than one budget). Header value via the existing seconds conversion (`Math.ceil(ms / 1000)` = 3).
- Control class: n/a (response shaping, no guard).

### C3 — entry family maps the timeout to TEAM_BUSY

- `assertCurrentTeamKeyVersion`: `TeamRotationInProgressError` →
  `TeamPasswordServiceError(API_ERROR.TEAM_BUSY, 409)`. The three routes that map
  `TeamPasswordServiceError` answer `teamBusy()` when `e.code === TEAM_BUSY`, else unchanged.
- Bulk import: a `TEAM_BUSY` service error aborts the whole import exactly as a mismatch does
  (rethrown out of the per-entry savepoint and the transaction), answering `teamBusy()`. Rationale:
  continuing past a timed-out savepoint would make each remaining entry wait up to 3 s again,
  overrunning the transaction timeout into a bare 500, and would split the import across a
  rotation.
- Routes 2–6: `TeamRotationInProgressError` → their outcome/refusal carries `TEAM_BUSY`; the final
  response for that code is `teamBusy()`.
- confirm-key: `TeamRotationInProgressError` → a new `busy` outcome → `teamBusy()`. The explicit
  version comparison (`version_mismatch`) is unchanged.
- Invariant (R42, app-enforced): after the change,
  `rg -n "TeamRotationInProgressError" src/app src/lib/services --glob '!**/*.test.ts'` shows no
  catch arm that yields `TEAM_KEY_VERSION_MISMATCH`. Checked by grep in Phase 2/3; not a CI gate
  (the class is 7 sites, all touched here; a gate would be a tripwire over spellings — see SC3).
- Acceptance: each route's timeout cell answers 409 `TEAM_BUSY` + `Retry-After: 3` and writes
  nothing; each route's existing genuine-mismatch cell still answers `TEAM_KEY_VERSION_MISMATCH`.

### C4 — membership family: lock-wait timeouts answer TEAM_BUSY

- `isLockWaitTimeout(e): boolean` in `tenant-row-lock.ts` =
  `e instanceof TeamRotationInProgressError || e instanceof TenantMemberLockTimeoutError`.
- `membershipConflictResponse(e): NextResponse` in `tenant-row-lock.ts` (callers already import
  from it): `isLockWaitTimeout(e) ? teamBusy() : errorResponse(API_ERROR.CONFLICT)`. Every
  non-SCIM `isMembershipLockConflict` site returns it instead of `errorResponse(CONFLICT)`.
- `vault/reset` and `vault/admin-reset`: `isTeamRotationConflict(e)` →
  `e instanceof TeamRotationInProgressError ? teamBusy() : errorResponse(CONFLICT)`.
- `isMembershipLockConflict` / `isTeamRotationConflict` keep their meaning (directory sync and SCIM
  rely on them).
- Acceptance: helper unit cells for each of the five conflict kinds (two → TEAM_BUSY, three →
  CONFLICT); one route test per family site that already has a conflict cell updated accordingly.

### C5 — web client

Member set: the client callers of the routes in C3/C4. Derivation:
`rg -n "apiPath\.(teamPasswords|teamPasswordById|teamPasswordsBulkImport|teamPasswordAttachments|teamPasswordAttachmentById|teamPasswordAttachmentMigrate|teamPasswordRekey|teamPasswordHistoryRestore|teamMemberConfirmKey|teamMembers|teamMemberById|teamInvitations|...)" src/components src/hooks src/lib --glob '!**/*.test.*'`
(Phase 2 records the exact command and output in the deviation log; this list is the starting
point):

- `src/lib/team/rekey-runner.ts` (re-key POST, migrate): new `REKEY_ACTION.BUSY_WAIT` for
  `TEAM_BUSY` — sleep `Retry-After` (clamped like the 429 path), retry the same request, count
  against `MAX_ROTATION_WAITS`; does NOT call `invalidateTeamKeys`. `TEAM_KEY_VERSION_MISMATCH`
  keeps `REFRESH_KEYS`.
- `src/components/team/forms/team-entry-submit.ts` `saveErrorMessage`: `TEAM_BUSY` → a
  retry-shortly message (not `teamEntryTeamKeyChanged`).
- `src/components/passwords/import/password-import-importer.ts`: a 409 `TEAM_BUSY` chunk is retried
  like a 429 (same `Retry-After` handling and `MAX_RETRIES_PER_CHUNK` budget).
- `src/components/team/forms/team-attachment-section.tsx` delete: surface the API error through
  `toastApiError` (as upload already does) instead of the fixed `deleteError`.
- Callers that already render `tApi(apiErrorToI18nKey(code))` (history restore, attachment upload,
  membership dialogs) get `teamBusy` with no code change; Phase 2 confirms each.
- `team-vault-core.tsx` confirm-key distribution: silent retry on next poll — no change.
- Extension, iOS, CLI: no team writer. Derivation: `rg -n "/teams/" extension/src cli/src ios
  --glob '!**/*test*'` shows only team reads (extension `teamPasswords`/`teamPasswordById` GETs;
  iOS `EntryFetcher`). No change; recorded so the issue's "and the extension" is answered.
- Consumer-flow walkthroughs:
  - rekey-runner reads `{ error, Retry-After }`: `error` selects BUSY_WAIT, `Retry-After` sets the
    sleep.
  - importer reads `{ status, error, Retry-After }`: 409 + `TEAM_BUSY` selects the retry,
    `Retry-After` the delay.
  - entry form reads `{ error }` → message key.
  - `tApi` callers read `{ error }` → `teamBusy` message.

### C6 — docs

`docs/api/error-handling.md`: `TEAM_BUSY` row (409, `Retry-After`, `teamBusy()`), beside the
`RATE_LIMIT_EXCEEDED` header row.

## Forbidden patterns

- pattern: `TeamRotationInProgressError\)[\s\S]{0,120}TEAM_KEY_VERSION_MISMATCH` — reason: the
  defect this plan removes (multiline grep over `src/app src/lib/services`).
- pattern: `errorResponse\(API_ERROR\.TEAM_BUSY` outside `api-response.ts` — reason: bypasses
  `teamBusy()` and drops `Retry-After`.

## Testing strategy

- Unit (route tests, mocked lock helper): for each C3 route, flip the existing
  `TeamRotationInProgressError` cell to expect 409 `TEAM_BUSY` + `Retry-After: "3"` and that no
  write/audit happened; keep/confirm a genuine-mismatch cell per route.
- Service: `team-password-service.test.ts` timeout → `TEAM_BUSY`; mismatch → unchanged.
- Bulk import: a `TEAM_BUSY` from the second entry aborts the import (no per-entry continue,
  `failedCount` path not taken, 409 `TEAM_BUSY`).
- `tenant-row-lock.test.ts`: `isLockWaitTimeout` / `membershipConflictResponse` across the five
  kinds.
- Integration (`team-key-version-guard.integration.test.ts`): the existing "waits past the lock
  timeout" cell now expects `TEAM_BUSY` and `Retry-After`; the parked-rotation cells (genuine
  mismatch after the wait) stay `TEAM_KEY_VERSION_MISMATCH` — the paired allow/deny that the
  issue's acceptance asks for, on the real lock.
- Client: rekey-runner `TEAM_BUSY` → waits `Retry-After`, retries, never invalidates keys, gives up
  after the budget; importer retries a `TEAM_BUSY` chunk; `saveErrorMessage` case.
- Each new/changed assertion is red-proved against the pre-change mapping (RT7) on a scratchpad
  copy, never in place.

## Considerations & constraints

### Scope contract

- SC1: SCIM routes keep `scimError(409, membershipConflictMessage(e))`. SCIM clients read the SCIM
  envelope, not `API_ERROR` codes; the message already says "retry later". Owner: none needed.
- SC2: `TeamRotationLockError`, deadlock and `P2028` keep `CONFLICT`. They are retry-safe too, but
  they are not a lock wait that ran out, which is what `#1021` names; changing them is a separate
  decision about the `CONFLICT` contract. Owner: follow-up issue if wanted.
- SC3: No CI gate for C3's invariant. The member set is closed by this change and recorded by
  command; a future new catch arm is a review item.
- SC4: The rotation route itself takes `FOR NO KEY UPDATE` without a bounded wait and the
  retention-GC prune uses `SKIP LOCKED`; neither produces this timeout. Unchanged.

### Risks

- The re-key runner previously recovered from a timed-out wait by refreshing keys and pausing 3 s;
  BUSY_WAIT keeps the pause (Retry-After 3 s) and drops only the needless key refresh. If the
  rotation committed meanwhile, the retried request answers a genuine mismatch and REFRESH_KEYS
  runs then.

## User operation scenarios

1. Owner rotates a large team's key; a member saves an entry during it → after ~3 s, "Another
   change to this team is in progress…"; retrying after the rotation answers a mismatch, and the
   form's existing key-changed path applies.
2. Admin runs the re-key pass while the retention GC prunes old team keys → a rekey POST times out
   → runner waits 3 s and retries without dropping cached keys.
3. Admin approves a SCIM-pending member during a rotation → `TEAM_BUSY` toast instead of
   "already modified".
4. CSV import into a team during a rotation → the chunk is retried after `Retry-After` instead of
   counted as failed.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `TEAM_BUSY` code, 409, i18n | locked |
| C2 | `teamBusy()` + `Retry-After` constant | locked |
| C3 | entry family timeout → `TEAM_BUSY` | locked |
| C4 | membership family lock-wait timeout → `TEAM_BUSY` | locked |
| C5 | web client handling | locked |
| C6 | error-handling doc | locked |
