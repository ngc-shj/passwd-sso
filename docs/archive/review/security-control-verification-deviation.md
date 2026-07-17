# Coding Deviation Log: security-control-verification

## C5 — additional route catch
- `src/app/api/passwords/route.ts` gained a `KeyVersionMismatchError` → 409 catch. Not explicitly
  listed in the C5 member table, but it is a direct caller of the now-guarded
  `createPersonalPasswordEntry`, so the mapping is required for the POST `/api/passwords` path to
  return the contracted 409 rather than a 500. In-scope by C5's intent.

## C5 — raw-sql-usage.txt: 4 entries, not 3
- Plan C5 named 3 new raw-SQL sites; a 4th was required for the history-restore route's new
  in-tx `FOR UPDATE` read (func-F2 fix moved the snapshot into the tx). Added with a purpose
  comment. Discovered by running `check-raw-sql-usage.mjs`.

## C5 — error-code reuse for rotation CAS + AAD rewrap
- `RotationCasConflictError` → `KEY_VERSION_MISMATCH` (409): the CAS conflict is semantically
  "vault key state moved under you", the same client-facing shape as a stale-keyVersion write.
- `AttachmentCekWrapAadVersionMismatchError` → `ATTACHMENT_INCONSISTENT_VERSION` (existing
  attachment-version code), NOT KEY_VERSION_MISMATCH. Upload/migrate boundary mismatches return
  400 `validationError()`. No new error codes minted for C11.

## C10 → team-rotate parity (P2002)
- C10 authorized mapping the personal VaultKey `@@unique` P2002 to the rotation-conflict error.
  During C7 the same defect class surfaced on the team side: a concurrent team-rotate loser could
  hit a raw P2002 on `teamMemberKey.createMany` → unhandled 500 instead of a clean 409. Fixed for
  parity: `src/app/api/teams/[teamId]/rotate-key/route.ts` now maps
  `Prisma.PrismaClientKnownRequestError code P2002` → `TEAM_KEY_VERSION_MISMATCH` (409). Mirrors
  the personal fix; leaving the team side asymmetric is exactly the API-drift class this plan
  targets. C7 test tightened to assert the loser is always 200|409, never 500.

## C9a — plan premise corrected empirically
- The plan assumed approve-vs-revoke on a pending master-key rotation row are mutually exclusive.
  The actual revoke CAS checks only `executedAt`/`revokedAt` (not `approvedAt`), so both can
  legitimately commit. This is SAFE: execute's CAS requires `revokedAt: null`, so once revoke
  commits, the destructive share-revocation (execute) is permanently blocked. The C9a test asserts
  the real invariant (revoke ⟹ execute blocked) instead of the imprecise "mutually exclusive"
  premise. No production change needed.

## C6 T3 — non-vacuity fix (found via lint prefer-const)
- The T3 rotation-vs-write loop passed a stale `currentAccountSalt` snapshot on every iteration.
  Because `applyVaultRotation` rewrites `account_salt`, the tuple-CAS would reject every rotation
  after the first, making the "50-iteration" loop vacuous (only 1 real rotation). Fixed:
  `currentAccountSalt` now tracks each successful rotation's payload salt. Surfaced by the
  `prefer-const` lint error (the var was flagged never-reassigned — a real vacuity bug, not a
  style nit); resolved by making the loop correct rather than suppressing the warning.

## C9b — placement
- The execute partial-failure unit test lives in a separate file
  (`.../execute/execute-partial-failure.test.ts`) rather than the C9 integration file, because its
  module-scope `vi.mock("@/lib/crypto/crypto-server")` would shadow the real `hashToken` the
  integration seeding needs. Keeps both real-symbol.

## Test-infra: audit-outbox drain race
- Added a bounded backoff-retry (`deleteTestDataWithRetry`) in the three heaviest new integration
  files to tolerate the live audit-outbox-worker draining rows into audit_logs mid-cleanup. Scoped
  to the new files rather than editing shared `helpers.ts` to avoid destabilizing ~85 passing
  integration files. Same failure mode confirmed pre-existing in an unrelated file — environmental.
