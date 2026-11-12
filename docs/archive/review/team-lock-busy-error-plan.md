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
  `409 { error: "TEAM_BUSY" }` + `Retry-After` on every route that can raise it, except SCIM
  (SC1) and `vault/admin-reset` (SC5). In the membership family it is reachable only where a team
  row is locked (`lockTeamsAgainstRotation`, `lockMemberTeamsAgainstRotation`, or a direct
  `withBoundedLockWait`): invitations/accept, invitations, members, members/[memberId] (3),
  approve, reject, `tenant/teams/[teamId]/owner`, `vault/reset`. `teams/route.ts` and
  `tenant/members/[userId]` take only `lockTenantRows` (`TenantMemberLockTimeoutError`) and so
  keep answering `CONFLICT` (review F2-1).
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
- `membershipConflictResponse(e): NextResponse` in a new `src/lib/http/lock-conflict-response.ts`
  (HTTP layer; `tenant-row-lock.ts` stays free of `next/server`, since directory sync and the
  services import it — review F2-4): `isTeamLockTimeout(e) ? teamBusy() :
  errorResponse(API_ERROR.CONFLICT)`. Every non-SCIM `isMembershipLockConflict` site returns it in
  place of `errorResponse(CONFLICT)` — uniformly, including the two tenant-lock-only routes, where
  it can only yield `CONFLICT`.
- `vault/reset`: `isTeamLockTimeout(e) ? teamBusy() : errorResponse(CONFLICT)` for
  `isTeamRotationConflict(e)`.
- `isMembershipLockConflict` / `isTeamRotationConflict` keep their meaning (SCIM uses the former).
- Accepted (review S-F1, S-F2): the lock precedes the in-transaction actor re-check in some routes,
  so a member demoted after `requireTeamPermission` can see `TEAM_BUSY` for up to 3 s; the retry
  then answers 403. Pre-transaction authorization still runs first, so an unauthorized principal
  never sees it. `TEAM_BUSY` names no team; the routes add no team id to the body.
- Accepted (review F3-3): membership routes share one `LockBudget` across the tenant-row wait and
  the team-row wait; when the tenant wait spends it, `withBoundedLockWait` throws the team
  timeout before waiting on a team row, so `TEAM_BUSY` can answer a contention that was on the
  tenant row. Both are transient and retry-safe and the advice ("try again in a moment") is
  right; distinguishing a spent budget would add a third error class for wording only.

### C5 — web client

Member set derivation (recorded with output in the deviation log at Phase 2):
`rg -n "apiPath\.(teamPasswords|teamPasswordById|teamPasswordsBulkImport|teamPasswordAttachments|teamPasswordAttachmentById|teamPasswordAttachmentMigrate|teamPasswordRekey|teamPasswordHistoryRestore|teamMemberConfirmKey|teamMembers|teamMemberById|teamMemberApprove|teamMemberReject|teamInvitations|tenantMemberById|tenantTeamOwner)|API_PATH\.(TEAMS|TEAMS_INVITATIONS_ACCEPT|VAULT_RESET)\b" src --glob '!**/*.test.*' --glob '!src/app/api/**'`
(names checked against `src/lib/constants/auth/api-path.ts`; any that fails to resolve is fixed
before the run, not dropped). Known members and their change:

- `src/lib/team/rekey-runner.ts`: `TEAM_BUSY` → new `REKEY_ACTION.BUSY_WAIT` in `ACTION_BY_CODE`,
  and a `BUSY_WAIT` arm in every chain that consumes `classifyRekeyResponse` for a locking request:
  the upgrade PUT, the migrate PUT (`migrateRefusal`), the re-key POST. (The re-key GET and the
  migrate download GET take no lock.) `BUSY_WAIT`: sleep `min(retryAfterMs(res),
  REKEY_BUSY_MAX_WAIT_MS)` with `REKEY_BUSY_MAX_WAIT_MS = 30 s`, retry the same request, count
  against its own pass-wide `MAX_BUSY_WAITS = 10` (like `rateWaits`), never call
  `invalidateTeamKeys`. Why a separate budget (review F3-1): only a `FOR NO KEY UPDATE` holder —
  a rotation, or the retention-GC prune's short hold — blocks these `FOR SHARE` requests, and one
  long rotation produces several consecutive busy waits; sharing the budget of 5 would leave no
  refresh budget for the mismatch that follows the rotation's commit. Update the `refreshKeys` comment
  and `Teams.rekeyStopRetryBudget` (en/ja) to name a busy team.
- `src/components/team/forms/team-entry-submit.ts` `saveErrorMessage`: `TEAM_BUSY` → new
  `PasswordForm.teamEntryTeamBusy` (en/ja).
- `src/components/passwords/import/password-import-importer.ts`: a 409 with `TEAM_BUSY` is retried
  in the same loop as 429 (same `Retry-After` clamp and default; `MAX_RETRIES_PER_CHUNK = 3`
  attempts, i.e. 2 retries, worst case ≈ 3 × 3 s lock wait + 2 × 3 s sleep ≈ 15 s). Other 409s are
  not retried. A rotation outlasting that still fails the chunk, as a 429 storm does.
- `src/components/team/forms/team-attachment-section.tsx` delete: `toastApiError(res, tApi)` instead
  of the fixed `deleteError` — deliberately for every API error, as upload already does; network
  errors keep `deleteError`.
- `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx` approve/reject: `TEAM_BUSY` →
  `approvalBusyRetry` (same meaning as today's `CONFLICT`).
- `src/components/team/management/ownerless-teams-card.tsx`: `TEAM_BUSY` → `tApi("teamBusy")` and
  refresh, as `CONFLICT` does.
- `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx` role change (PUT) and removal
  (DELETE), `.../members/transfer-ownership/page.tsx` (PUT), and
  `src/app/[locale]/dashboard/teams/invite/[token]/page.tsx` (accept): today any unexpected
  non-ok becomes `networkError` / `acceptFailed`. The members-list role/remove and
  transfer-ownership handlers render `tApi(apiErrorToI18nKey(code))` (transfer-ownership adds
  `useTranslations("ApiErrors")` and the import) for any coded non-ok response (so `CONFLICT` and `TEAM_BUSY` both read correctly — review F3-4), keeping
  `networkError` for a code-less failure; the accept page adds a `TEAM_BUSY` arm →
  `tApi("teamBusy")` beside its 410/403/404 arms (review F2-2).
- Status-keyed consumers (any 409 → one fixed state message) misreport other 409 codes today.
  Each keys its fixed message on the specific code and renders `tApi(apiErrorToI18nKey(code))`
  for any other 409 (an absent or unknown code falls to `unknownError` via the same mapping):
  - `team-invite-by-email-section.tsx`: `INVITATION_ALREADY_SENT` → `alreadyInvited`,
    `ALREADY_A_MEMBER` → `alreadyMember`; `SCIM_*`, `CONFLICT`, `TEAM_BUSY` → `tApi`.
  - `team-add-from-tenant-section.tsx`: keeps its `SCIM_*` arms; `ALREADY_A_MEMBER` →
    `alreadyMember`; anything else → `tApi`.
  - `team-create-dialog.tsx` (route can answer `CONFLICT`, never `TEAM_BUSY`):
    `SLUG_ALREADY_TAKEN` → `slugTaken` on the slug field; any other 409 → `tApi` as a toast.
  - `tenant-members-card.tsx` (same): `SCIM_MANAGED_MEMBER` → `scimManagedRoleError`; else `tApi`.
- No change, confirmed: history restore, attachment upload (incl. the upgrade PUT via
  `TeamEntryUpgradeError`) and `vault-reset/page.tsx` already render
  `tApi(apiErrorToI18nKey(code))`; `team-vault-core.tsx` confirm-key distribution swallows errors
  and retries on the next poll; `team-rotate-key-button.tsx` (rotation takes no bounded wait);
  the archive-only PUT (`use-team-entry-mutations`, `team-vault-list-adapter`) is not a full
  update and takes no lock.
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

### C7 — one error-body read per `Response` (pre-existing defect, review F4-1)

`handleStepUpError` / `throwIfStepUp` (`src/lib/http/handle-step-up-error.ts`) read the caller's
`Response` body through `readApiErrorBody`, which calls `res.json()` with no clone. Every caller
that then reads the code again (`readApiErrorBody(res)`, `toastApiError(res, …)`) gets `null` in
a browser (body already used), so its code arms never fire — e.g. the members-list approve/reject
`CONFLICT` → `approvalBusyRetry` arm has never been reachable. Unit tests mock a re-readable
`json()` and hid it. The C5 `TEAM_BUSY` arms on step-up-gated consumers depend on this fix.

- Fix at the shared reader, not per site: a memoized raw parse in `read-api-error-body.ts`,
  `parseJsonBodyOnce(res)` (module-level `WeakMap<Response, Promise<unknown>>`; parse failure →
  `null`, never rejects; no `ok` check). `readApiErrorBody` keeps its `res.ok → null` guard first
  and its shape check, now over the memoized parse. `toastApiError` reads the memoized raw parse
  as `(parsed ?? {})` with its existing `body.error ?? fallback` logic, so its contract is
  unchanged for every response it handles today (ok or not, any `error` type) — round-6 F6-T1.
  Two behaviour changes, both deliberate: a second reader of a used body now sees the code; and a
  literal JSON `null` body, which today throws a `TypeError` out of `toastApiError` (`null.error`),
  now shows the fallback toast (round-7 F7-1 / F7-T1). Known caller where that shows
  (round-6 F6-2): `tenant-reset-history-dialog.tsx` calls `readApiErrorBody(res)` then
  `toastApiError(res, …, FORBIDDEN)`; it now shows the server's specific code instead of always
  the `FORBIDDEN` fallback — intended, matching that code's comment.
- Why not `res.clone()` in the helpers (round-5 F5-1 / Q5-1): it throws on the plain-object
  `Response` mocks used across ~24 callers' tests and on an already-consumed body, and it fixes
  only the step-up helpers, not a second `readApiErrorBody`/`toastApiError` on the same response.
  The memo needs only `json()`, which every existing mock provides.
- Member set swept (round-5 F5-3; recorded with command output at Phase 2):
  `rg -n "handleStepUpError\(|throwIfStepUp\(" src --glob '!**/*.test.*'` (callers that read the
  body afterwards: members-list approve/reject, ownerless card — fixed by the memo; callers that
  pass `res.clone()` stay correct) and
  `rg -n "readApiErrorBody\(|toastApiError\(" src --glob '!**/*.test.*'` (no other caller reads
  one response twice; any direct `res.json()` after a helper on the error path is listed and
  switched to `readApiErrorBody`). Signatures and the step-up guard's tokens are unchanged; run
  `scripts/checks/check-step-up-client-coverage.sh` unpiped after the change.
- Acceptance: with a real `Response` (single-read body), a second `readApiErrorBody(res)` and a
  `toastApiError(res, …)` after `handleStepUpError` returned `false` both see the code; a step-up
  403 still triggers reauth; full unit suite run right after the C7 edit, and any failure from a
  mock object reused across tests with a changed `json()` (the memo is per object) is fixed by a
  fresh mock per test, not by weakening the memo (round-6 F6-1).

### C8 — `apiErrorToI18nKey` looks up own keys only (pre-existing, review S4 note)

Both lookups — `overrides?.[code]` and `error in API_ERROR_I18N` — match inherited names
(`"constructor"`, `"toString"`, `"__proto__"`), returning a function or object instead of a key.
C5 widens rendering of server-supplied codes through this function, so both use
`Object.hasOwn` (available: `lib` includes `esnext`; ES2022 runtimes). Acceptance: `"constructor"`
with and without an `overrides` object → `unknownError` (a `string`); a real code → its key; a
real code with an override → the override. Same `in`-over-an-i18n-map pattern elsewhere is swept
at Phase 2 (`rg -n " in [A-Z_]+_I18N\b" src`); known member: `eaErrorToI18nKey` (`error in
EA_I18N`), fixed the same way (round-6 S6-1).

## Forbidden patterns

- pattern: `errorResponse\(API_ERROR\.TEAM_BUSY` outside `src/lib/http/api-response.ts` — reason:
  bypasses `teamBusy()` and drops `Retry-After`.

## Testing strategy

Every flipped or new cell asserts the code, `Retry-After` (present for `TEAM_BUSY`, absent for
`CONFLICT`), and that no write or audit mock was called. Each change cell is red-proved against
the old mapping on a scratchpad copy (RT7), never in place. Cells marked **pin** (an outcome the
old code also produced) cannot fail on the old mapping by construction; each is red-proved by a
mutation on its own decision path, on the scratchpad copy: `isTeamLockTimeout` → always `true`
for the `membershipConflictResponse` and `vault/reset` pins; the route's arm replaced by
`teamBusy()` for the `vault/admin-reset` and SCIM pins; for each entry-family genuine-mismatch
cell, the statement that produces the mismatch answer changed to `TEAM_BUSY` — the
version-comparison throw in `assertCurrentTeamKeyVersion`, the route's own mismatch return where
one exists (history restore, re-key), and confirm-key's `version_mismatch` response branch. (The
entry family decides the timeout with `instanceof TeamRotationInProgressError`, a separate arm
from the mismatch, so widening the timeout arm would not reach these cells.)

- Shared: `api-error-codes.test.ts` (count, 409, `teamBusy`); `api-response.test.ts` `teamBusy()`
  (409, `Retry-After: "3"`); `tenant-row-lock.test.ts` `membershipConflictResponse` over all five
  kinds (one → `TEAM_BUSY`, four → `CONFLICT`); `isTeamLockTimeout`.
- Entry family — flip: `team-password-service.test.ts` (timeout cell, `55P03` through the real
  helper), `rekey/route.test.ts`, `attachments/route.test.ts`, `attachments/[attachmentId]/route.test.ts`,
  `migrate/route.test.ts`, `confirm-key/route.test.ts` (timeout cell; mismatch cell stays). Add:
  history restore timeout + mismatch cells; entry POST/PUT route `TEAM_BUSY` → `teamBusy()` cells;
  bulk import `TEAM_BUSY` abort cells — first entry times out (no further service call), and
  entry 1 succeeds then entry 2 times out — each asserting 409 `TEAM_BUSY` and that neither
  `logAuditAsync` nor `logAuditBulkAsync` ran; mismatch cell stays. `team-entry-rekey.test.ts` stubs
  the error class: use the real class via `importActual` so `isTeamLockTimeout` sees the same
  identity.
- Membership family — per site that can raise the team-lock timeout (R1 list): tighten existing
  timeout cells (bare 409 or `CONFLICT`) to `TEAM_BUSY`, and add a paired `TeamRotationLockError`
  or `TenantMemberLockTimeoutError` → `CONFLICT` **pin**; add both where none exists
  (`teams/[teamId]/invitations`, `tenant/teams/[teamId]/owner`). `teams/route.ts` and
  `tenant/members/[userId]` get only a `TenantMemberLockTimeoutError` → `CONFLICT` **pin** (no
  `TEAM_BUSY` cell: unreachable there). In `members/[memberId]/route.test.ts` the three existing
  timeout cells (PUT, PUT transfer, DELETE) throw `55P03` on `FROM tenant_members` — a tenant-row
  timeout — so they become `CONFLICT` pins with the code asserted; the `TEAM_BUSY` cells are new,
  throwing `55P03` on the `FROM teams` lock query (`mockTeamLockQuery`) for each method. `approve`/`reject` existing `TeamRotationLockError` cells stay
  `CONFLICT` and gain a `TEAM_BUSY` timeout cell. `vault/reset`: timeout → `TEAM_BUSY`, lock error →
  `CONFLICT`; `vault/admin-reset`: timeout → `CONFLICT` (SC5).
- Integration (`team-key-version-guard.integration.test.ts`, real lock): flip the create timeout
  cell and the member-removal timeout cell to `TEAM_BUSY`; add PUT, bulk-import and confirm-key
  timeout cells on `withRotationStandIn` (each with the `15_000` test timeout the existing stand-in
  cells use). Every integration `TEAM_BUSY` cell asserts `Retry-After: "3"`, no new rows, and no
  audit rows (confirm-key reuses `keyDistributeAudits`). New cells assert only the lower bound
  `waitedMs >= TEAM_KEY_LOCK_TIMEOUT_MS`; the existing upper bound stays on the cells that have it.
  Parked-rotation cells (genuine mismatch after the wait) stay `TEAM_KEY_VERSION_MISMATCH`.
- Client: `rekey-runner.test.ts` — `TEAM_BUSY` on each of upgrade PUT, migrate PUT, re-key POST →
  sleeps `Retry-After`, retries, `invalidateTeamKeys` not called; a huge `Retry-After` is clamped
  to 30 s; a missing header uses the existing default; budget boundary: the 10th busy wait still
  retries and the 11th stops with `RETRY_BUDGET_EXHAUSTED` (same `++n > MAX` form as the other
  counters); busy waits consume neither `MAX_ROTATION_WAITS` (5 rotation waits after 10 busy
  waits still succeed) nor `MAX_RATE_LIMIT_WAITS`; `TEAM_BUSY` then genuine mismatch →
  `REFRESH_KEYS`.
  `password-import-importer.test.ts` — 409 `TEAM_BUSY` retried; other 409 not; `TEAM_BUSY` on every
  attempt → chunk failed after exactly 3 calls; huge `Retry-After` clamped; missing header →
  default. `team-entry-submit.test.ts` table row. `team-attachment-section.test.tsx` — delete API
  error → `toastApiError`; rejected fetch → `deleteError`.
  UI consumers (members-list approve/reject/role/remove, transfer-ownership, invite-accept page,
  ownerless card, the two status-keyed consumers that can receive it): a `TEAM_BUSY` cell each;
  members-list role/remove and transfer-ownership also a `CONFLICT` cell and a code-less failure
  cell (a thrown fetch or a non-JSON 5xx → `networkError`); create dialog: non-slug 409 → toast,
  slug field untouched. Every UI cell on a step-up-gated consumer returns a real `Response`
  (body readable once), so it fails while C7 is unfixed.
- C7: `read-api-error-body.test.ts` / `handle-step-up-error.test.ts` / `toast-api-error.test.ts` —
  real `Response` (undici, vitest `node` env, single-read body): a second `readApiErrorBody` and a
  `toastApiError` after `handleStepUpError`/`throwIfStepUp` returned `false` see the code (fail
  on the old reader); the same object read twice → identical result with `json` called once; two
  distinct objects → their own parses; `toastApiError` keeps today's results for an ok response
  and a non-string `error` (existing `toast-api-error.test.ts` cells unchanged), and a JSON `null`
  body shows the fallback toast (`unknownError` without a fallback code);
  a step-up 403 read through the memo still triggers (pin; red-proof: memo caches `null`).
  Consumer level: convert the members-list approve/reject `it.each` cells (incl. `CONFLICT` →
  `approvalBusyRetry`) to real `Response`s; write the new ownerless-card cells and a
  `tenant-reset-history-dialog` cell (specific code shown, not the `FORBIDDEN` fallback) with real
  `Response`s. Each asserts the arm's outcome (toast key, refresh), not just no throw. Red-proof:
  remove the `WeakMap` get/set in `parseJsonBodyOnce` on the scratchpad copy.
- C8: `api-error-codes.test.ts` — `"constructor"`/`"toString"`/`"__proto__"`, with and without
  `overrides`, → `unknownError` and `typeof === "string"`; positive controls (real code, real code
  with override); `eaErrorToI18nKey("constructor")` → `actionFailed`. Red-proof: revert each
  lookup separately on the scratchpad copy (`"constructor"` with overrides kills the `overrides`
  mutation; `"__proto__"` without overrides kills the `API_ERROR_I18N` one; the EA cell its own).
- Runner clamp boundary: `Retry-After` 30 → 30 s, 31 → 30 s.
  Status-keyed consumers: existing fixed-message cells' mocks carry the real route code
  (`SLUG_ALREADY_TAKEN`, `SCIM_MANAGED_MEMBER`, `INVITATION_ALREADY_SENT`, `ALREADY_A_MEMBER`)
  instead of `{}` or another code; plus one cell each for a `CONFLICT` 409 and a code-less 409
  rendering the generic `tApi` message. `ownerless-teams-card.test.tsx` is new: `CONFLICT` (refresh
  + `ownerAssignConflict`) and `TEAM_BUSY` cells.

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
2. Admin runs the re-key pass while another admin starts a rotation of the same team → a re-key
   POST times out on the rotation's `FOR NO KEY UPDATE` → runner waits 3 s and retries; once the
   rotation commits, the retry answers a mismatch and the runner refreshes keys.
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
| C7 | memoized error-body read (pre-existing double-read) | locked |
| C8 | `apiErrorToI18nKey` own-key lookup | locked |

## Implementation Checklist

Derivations re-run at Phase 2 start (output matched the plan's member sets; C8 sweep found exactly
`API_ERROR_I18N` and `EA_I18N`).

- Foundation (orchestrator, commit `504e30f13`): `api-error-codes.ts` (+test count 205),
  `messages/{en,ja}/ApiErrors.json`, `rotate-key.ts` `TEAM_BUSY_RETRY_AFTER_MS`, `api-response.ts`
  `teamBusy()`, `lock-conflict-response.ts` `membershipConflictResponse`,
  `team-key-rotation-lock.ts` `isTeamLockTimeout`, `read-api-error-body.ts` `parseJsonBodyOnce`
  (+ CLI/extension copies, see deviation D1), `toast-api-error.ts`.
- Server batch: `team-password-service.ts`; routes `passwords`, `passwords/[id]`, `bulk-import`,
  `attachments`, `attachments/[attachmentId]`, `migrate`, `rekey`, `history/.../restore`,
  `confirm-key`; every non-SCIM `isMembershipLockConflict` site → `membershipConflictResponse`;
  `vault/reset`; docs (`error-handling.md`, `tenant-row-lock.ts` comment); their unit tests;
  `team-key-version-guard.integration.test.ts`; `team-entry-rekey.test.ts` `importActual`.
- Client batch: `rekey-runner.ts` (+ `Teams.rekeyStopRetryBudget`), `team-entry-submit.ts`
  (+ `PasswordForm.teamEntryTeamBusy`), `password-import-importer.ts`, `team-attachment-section.tsx`,
  members-list page, transfer-ownership page, invite-accept page, `ownerless-teams-card.tsx`,
  invite/add/create/tenant-members consumers; their tests (real `Response`s on step-up consumers).
- Foundation-test batch: `read-api-error-body`, `toast-api-error`, `handle-step-up-error`,
  `api-error-codes`, `api-response`, `lock-conflict-response`, `tenant-reset-history-dialog` tests.
- Reuse: `errorResponse`, `rateLimited` pattern, `readApiErrorBody`, `toastApiError`,
  `apiErrorToI18nKey`, `handleStepUpError`, `withRotationStandIn`, `MS_PER_SECOND`.
- CI parity: gates absent from `scripts/pre-pr.sh` that this diff can affect —
  `check:bypass-rls`, `check:rls-nesting`, `check:crypto-domains`,
  `check-state-mutation-centralization.sh`, `check-api-error-body-drift.sh` — are run directly at
  Step 2-4. Not affected (no file in their input set): terraform fmt/test-count, licenses,
  migration drift, npm audit.
