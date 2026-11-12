# Coding Deviation Log: team-lock-busy-error

- D1 (C7) — `parseJsonBodyOnce` is exported and also added to `cli/src/lib/api-error-body.ts` and
  `extension/src/lib/api-error-body.ts`. The plan placed the memo in the main reader only, but
  `scripts/checks/check-api-error-body-drift.sh` requires the three copies to match after
  normalization, and the CLI/extension readers have the same single-read hazard. The `WeakMap`
  is declared after the function in all three because the drift normalizer drops everything
  before a file's first `export`. The plan called the parser module-private; it is exported because
  `toastApiError` (another module) reads through it.
- D2 (C3 tests) — history restore has no team-key-version mismatch path (its only
  `TEAM_KEY_VERSION_MISMATCH` return was the timeout arm), so it gets the timeout cell only; the
  existing 409 `HISTORY_KEY_UNAVAILABLE` cell asserts `Retry-After` absent as its genuine-refusal
  control. The re-key route's genuine mismatch is `TEAM_KEY_VERSION_CHANGED`, pinned by its
  existing cell.
- D3 (C5) — members-list approve/reject map both `CONFLICT` and `TEAM_BUSY` to
  `approvalBusyRetry` (same meaning); `password-import-importer.ts` reads the 409 code through
  `readApiErrorBody` (`isTeamBusy`). `team-add-from-tenant-section` keeps plain-object mocks for its
  `SCIM_*` cells: that consumer calls `readApiErrorBody` only, never a step-up helper first.
- D4 (tests) — `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.test.ts` gained a
  partial `@/lib/audit/audit` mock (`importOriginal`) so its TEAM_BUSY cell can assert no audit.
  `src/__tests__/db-integration/team-key-version-guard.integration.test.ts` gained a
  `teamAuditRows` helper reading `audit_outbox` by team (upstream of the drain, per the
  async-I/O observation rule). New CLI/extension memo tests:
  `cli/src/__tests__/unit/api-error-body.test.ts`, `extension/src/__tests__/api-error-body.test.ts`.
- D5 (test title) — the approve route's pre-existing `TeamRotationLockError` cell was titled as a
  lock-wait timeout; retitled "when the team row cannot be locked" (it pins CONFLICT).

## Red-proof record (RT7)

Run by the orchestrator on scratch configs under the session scratchpad that alias one module to a
mutated copy and run the real test files; no production file was edited.

- Membership/vault pins — `@/lib/http/lock-conflict-response` aliased to "always `teamBusy()`":
  13 CONFLICT pins failed across all 10 route test files (teams, invitations, invitations/accept,
  members, members/[memberId] ×4, approve, reject, owner, tenant members, vault/reset).
- Entry-family genuine-mismatch cells — `@/lib/http/api-response` aliased so `errorResponse` turns
  `TEAM_KEY_VERSION_MISMATCH` into `TEAM_BUSY`: 5 cells failed (passwords POST, PUT, bulk-import,
  confirm-key ×2); the re-key route stayed green as expected (its mismatch is a different code).
- TEAM_BUSY change cells: fail on the old mapping by construction (`TEAM_BUSY` did not exist).
- C7/C8 cells: red-proved by the foundation-test batch on scratch copies (12 cells failed with the
  memo removed / `in` restored; the tenant-reset-history-dialog cell via an aliased scratch config).

## Verification (Phase 2-4)

- `npm run lint` 0; `npx vitest run` 1162 files / 22140 tests pass; CLI 36/426 and extension
  92/2804 pass; CLI/extension `tsc` clean; `npx next build` 0.
- `npm run test:integration` (workers stopped): 145/150 files passed; the 5 failures were the MinIO
  suites refusing to start without `ANCHOR_TEST_S3_ENDPOINT`. Rerun with
  `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000` (those 5 + `team-key-version-guard`): 6/6 files,
  98 tests pass.
- CI-only gates run directly, each exit 0: `check:bypass-rls`, `check:rls-nesting`,
  `check:crypto-domains`, `check-state-mutation-centralization.sh`,
  `check-step-up-client-coverage.sh`, `check-api-error-body-drift.sh`. Forbidden pattern
  (`errorResponse(API_ERROR.TEAM_BUSY` outside `api-response.ts`): no hits.
