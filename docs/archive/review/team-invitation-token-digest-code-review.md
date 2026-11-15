# Code Review: team-invitation-token-digest
Date: 2026-11-15
Review round: 1

## Changes from Previous Round

Initial review (commit `600641a30`). The local LLM was unavailable, so each
expert reviewed the full diff.

## Functionality Findings

- **F1 [Major]** The migration's three DDL statements were not wrapped in
  `BEGIN;`/`COMMIT;`. `check-migration-transaction` failed, and a failure after
  the rename would leave `token_hash` holding plaintext, with old and new code
  both failing and a retry failing at the rename.
- **F2 [Major]** `check-destructive-migration` failed: no baseline entry recorded
  the one-release decision.
- **F3 [Minor]** (pre-existing) The pending invitation's icon-only cancel button
  had no accessible name.
- **F4 [Minor]** The issued link went only to the clipboard; a clipboard refusal
  reported `inviteFailed` although the invitation existed, and with a digest the
  link could not be recovered.

## Security Findings

No findings. Checked: plaintext and digest never leave through responses, audit
metadata, logs or Sentry (the invite path is already scrubbed); an unkeyed
SHA-256 of a 256-bit random token matches the repo's other one-time tokens; the
accept lookup is a unique-index equality behind the unchanged fail-closed
limiter; the `exempt` classification in the bearer-passkey manifest is accurate
and the exemption pin is unchanged; no column-level grant names `token`; the
rollout window leaves no state beyond failed requests. Residual: backups taken
before the migration hold plaintext for invitations then PENDING, acceptable
until they expire (at most 7 days) and only by a session for the invitee's
email.

## Testing Findings

Red-proofs on scratch copies: issuing plaintext, returning the stored value,
looking up by plaintext, and restoring the copy button each turned a new test
red; the second test tree stayed green under every mutation (fixture renames
only).

- **F1 [Major]** Keeping an existing PENDING invitation acceptable (issue point
  5) was tested only by evaluating the migration's `USING` expression; the
  migration itself never ran over an old-shape row.
- **F2 [Minor]** No test pinned that the GET list and the 201 omit `tokenHash`
  (adding it to either stayed green).

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1 OK (`hashToken` reused); R3 OK (every reader updated); R5 → F1; R7 OK (no E2E
reference to the copy button); R8 → F3; R14 OK (table-level grants only); R24
N/A; R29 → F4; R33 OK; R38 → F1; R41 OK; R44/R50 → F1, F2 (the static migration
gates had not been run).

### Security expert
R3, R14, R29, R39, R42 (other stored secrets derived from the schema: none raw),
R49 OK; RS1 N/A (database equality on a digest); RS2 OK (no new route, limiter
unchanged); RS3 OK (token 1..128 characters); RS4 OK; RS5, RS6 N/A.

### Testing expert
RT1 OK (the route tests assert call arguments, not mocked returns); RT2 OK; RT3
N/A; RT4 N/A; RT5 OK; RT6 N/A; RT7 → F1, F2; RT8 OK (the integration cell asserts
404 and that the row stays PENDING); RT9 OK; RT10 OK; RT11 N/A.

## Environment Verification Report

N/A — no environment constraints declared (no Phase 1 plan). The migration was
exercised locally by the integration cell below; it has not run against a
deployed database.

## Resolution Status

### Functionality F1 [Major] Migration not wrapped in a transaction
- Action: `BEGIN;`/`COMMIT;` around the three statements;
  `check-migration-transaction` exits 0. The dev database's checksum row was
  updated in place (deviation D5).
- Modified file: `prisma/migrations/20261115100000_team_invitation_token_digest/migration.sql`

### Functionality F2 [Major] No destructive-migration baseline entry
- Action: a baseline line records the owner's one-release decision, that old
  code fails invitation issue, list, cancel and accept until replaced (including
  after an app-image rollback), and that no row is lost.
  `check-destructive-migration` exits 0.
- Modified file: `scripts/checks/destructive-migration-baseline.txt`

### Functionality F3 [Minor] Cancel button without an accessible name
- Action: `aria-label={t("cancelInvitation")}`; the test selects it by name.
- Modified file: `src/components/team/members/team-pending-invitations-list.tsx`

### Functionality F4 [Minor] Link delivered only through the clipboard
- Action: the issued link is displayed once in a read-only field with a copy
  button (the SCIM token pattern); a clipboard refusal shows
  `invitedLinkNotCopied` instead of `inviteFailed`. Tests: displayed and copied
  on success; displayed, no error, `onSuccess` called when the clipboard
  refuses; not displayed on a 409.
- Modified file: `src/components/team/members/team-invite-by-email-section.tsx`,
  `messages/{en,ja}/Team.json`

### Testing F1 [Major] The migration never ran over an old-shape row
- Action: an A0 integration cell restores the old column holding a plaintext
  token, runs the migration file (its own `BEGIN`/`COMMIT` removed) as a
  temporary NOSUPERUSER NOBYPASSRLS table owner, and asserts the row count, that
  the token's digest finds the PENDING row, that the digest presented as a token
  does not, and the unique index's new name. All inside one transaction rolled
  back in `finally`. Red-proved with scratch copies of the migration: without
  `USING` the lookup fails; without the index rename the index check fails;
  swapping the statements errors.
- Modified file: `src/__tests__/db-integration/team-tenant-departure.integration.test.ts`

### Testing F2 [Minor] Responses could expose `tokenHash` unnoticed
- Action: the GET item and the 201 are pinned to their exact key sets.
- Modified file: `src/app/api/teams/[teamId]/invitations/route.test.ts`
