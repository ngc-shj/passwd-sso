# Code Review: session-containment-links-and-admin-credentials
Date: 2026-11-10
Review round: 2

## Changes from Previous Round
Initial review of `d22755a43` + `9305f4deb` (full diff). No Critical findings.

## Functionality Findings
- F1 [Major] A ticked token on a ticked service account was revoked by the service-account step and
  then reported as skipped.
- F2 [Minor] The dialog ignored `contained` (no warning for skipped rows), showed a passkey success
  string for a member with none, and dropped the admin's selection after a failed revoke.
- F3 [Minor] The revoke-all audit row and the member's notice named the passkeys read, not the ones
  deleted: the member's own passkey delete took no credential lock.
- F4 [Minor] `PERSONAL_LOG_ACCESS_REVOKE`'s `targetUserId` meaning was undocumented for a
  containment row.

## Security Findings
- N1 [Major] Containment wrote and audited one row at a time inside Prisma's 5 s default
  transaction: a member who created many footholds could make the revoke time out.
- N2 [Minor] The migration backfill cell committed a table-wide update to the shared dev database.

## Testing Findings
- T1 [Major] The atomicity cell accepted any rejection, not the probe constraint's.
- T2 [Major] The red-proof table covered four mutants; creator/tenant drops for most kinds and
  containment-after-commit were unproved.
- T3 [Major] Skipped service accounts and MCP clients carried no tokens, so collateral token
  revocation was undetectable; MCP refresh tokens were untested.
- T4 [Minor] Audit assertions checked counts, not `targetId`.
- T5 [Minor] The emergency-access cell counted rows loosely and its refusal had no positive control.
- T6 [Minor] The backfill cell did not assert the GUCs are restored.
- T7 [Minor] The secret-absence loop omitted the refresh token.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
Effects from rows written: F1, F3. Doc claims vs code: F4. en/ja parity: OK.

### Security expert
Bounded work in a transaction: N1. Shared-DB test side effects: N2. Predicates as readable literals:
OK. Step-up before writes: OK.

### Testing expert
Vacuous negatives: T1, T3. Red-proof completeness: T2. Positive controls: T5.

## Environment Verification Report
Integration `verified-local` (compose workers stopped and restarted); CI pending.

## Resolution Status

### Round 1
- N1 — Action: one `updateManyAndReturn` per kind on the live predicate; the returned rows are the
  rows counted and audited (`logAuditBulkInTx`, one batch per kind); child tokens revoked by the
  returned parent ids; emergency access stays a `transition()` loop bounded by
  `MEMBER_CONTAINMENT_MAX_IDS`. Transaction timeout `MEMBER_PASSKEY_REVOKE_TX_TIMEOUT_MS` (15 s). An
  integration cell writes 100 ids of every kind. The bulk audit write had made the revoke an
  unreadable `check-bypass-rls` site; the relation walk now reads `rows.map((r) => ({...}))`
  (deviation D10).
- N2 — Action: the backfill cell runs inside a rolled-back transaction and asserts nothing was
  committed.
- F1 — Action: counted contained, audited with `revokedWithServiceAccount: true`.
- F2 — Action: neutral `revokeAllPasskeysDone`; a warning naming kinds with skipped rows; the
  selection is kept (filtered to still-listed rows) after a failure.
- F3 — Action: `DELETE /api/webauthn/credentials/[id]` takes `lockUserAuthArtifacts` and answers 404
  on a zero count; revoke-all throws when its delete count differs from the rows read.
- F4 — Action: documented in `docs/operations/audit-log-reference.md`.
- T1 — Action: asserts SQLSTATE 23514 via `pgErrorCode`.
- T2 — Action: mutants M5–M13 in the deviation log, each red in its targeted cell.
- T3–T7 — Action: tokens seeded on skipped parents and asserted unchanged; refresh token revoked
  and in the secret loop; `targetId` asserted; exact row count and a 200 positive control; GUC
  restore asserted.

### Round 2
One reviewer, all three perspectives, on `a7e5b385c`: no Critical or Major findings; three Minor.
- R2-1 [Minor, security] The relation walk read `rows.map((r) => <body>)` through the callback's
  unannotated parameter, whose type is contextual and can be narrowed by a user type guard on the
  receiver — a `data` that was unreadable before could read as reaching nothing. Action: the mapped
  element must be an object literal, and every read of an unannotated parameter must sit in the
  value of a top-level property whose key is not a relation of the written model. Self-tests: a
  narrowed identity map, a narrowed spread, and a relation value spreading the parameter stay
  unreadable; scalar-key use stays readable. Dropping each guard turns its cell red.
- R2-2 [Minor, testing] The `revokedWithServiceAccount` filter's creator and expiry conjuncts were
  unpinned. Action: unit cell with a member-minted, a bystander-minted and an expired token on a
  contained service account: `{ revoked: 1, skipped: 2 }`, one marked row. Each conjunct forced true
  turns it red.
- R2-3 [Minor, testing] The revoke-all delete-count throw was unreached. Action: route cell where the
  delete removes fewer than were read: rejects, nothing after it runs, no audit, notice or mail.
  Removing the throw turns it red.

## Final state
Code review rounds: 2. Open findings: none.
