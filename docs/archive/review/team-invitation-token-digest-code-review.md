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

## Round 2 (incremental: 600641a30..ad20d6f13)

All round-1 items re-verified: functionality F1–F3 resolved (the baseline's
"issue, list, cancel or accept" checked against each old-code path), testing F1
and F2 resolved (key-set assertions red under a digest added to either response
or a spread row). Security: no findings; displaying the link widens nothing (it
is the issuing admin's own client state, unmounted with the dialog, no replay,
the same pattern as the SCIM token and API keys).

### Functionality
- **F5 [Major]** (also raised by security as Adjacent) The link shown once was
  never seen: the page's `onSuccess` closed the add dialog in the same render
  that set it, unmounting the section. On a clipboard refusal the toast pointed
  to a link that was not there. The component tests rendered the section alone.

### Testing
- **T1 [Minor]** Nothing pinned that the migration ran as a NOSUPERUSER
  NOBYPASSRLS role: deleting `SET LOCAL ROLE` stayed green.
- **T2 [Minor]** The BEGIN/COMMIT strip let a second, differently spelled
  transaction-control statement through, which would commit the test's role,
  ownership and column changes on the shared database.
- **T3 [Minor]** Clearing the shown link on the next invite was untested.

### Resolution Status (round 2)

#### F5 [Major] The issued link was unmounted before it rendered
- Action: the email-invite section's `onSuccess` refreshes the list and leaves
  the dialog open; adding an existing tenant member still closes it. Found while
  fixing: on a non-secure origin `navigator.clipboard` is undefined and the call
  threw synchronously into the failure path; the copy is now attempted inside a
  promise chain, so a missing clipboard is reported like a refused one. Tests: a
  page-level test with the real section inside the dialog (jsdom has no
  clipboard) asserts the link is on screen and no error toast; a component test
  removes the clipboard. Red-proved on scratch copies: closing the dialog again
  fails the page test; a direct `navigator.clipboard.writeText` fails both.
- Modified file: `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`,
  `src/components/team/members/team-invite-by-email-section.tsx`, their tests

#### T1 [Minor] Migration role unpinned
- Action: after `SET LOCAL ROLE` the cell asserts the current role is the
  temporary one with `rolsuper` and `rolbypassrls` false, and that it sees no
  rows through the table's policy (it is granted `EXECUTE` on
  `rls_bypass_admits`, inside the rolled-back transaction). Without the role
  switch the assertion reads `passwd_user | t | t`.
- Modified file: `src/__tests__/db-integration/team-tenant-departure.integration.test.ts`

#### T2 [Minor] Residual transaction control
- Action: the stripped body is refused when any statement starts with BEGIN,
  COMMIT, END, ROLLBACK, ABORT or START TRANSACTION (any case), before a
  connection is taken. Checked: the real file is admitted; the canonical pair
  plus a lowercase pair, `END;` and `START TRANSACTION;` are refused.
- Modified file: `src/__tests__/db-integration/team-tenant-departure.integration.test.ts`

#### T3 [Minor] Link reset untested
- Action: one render issues an invite (link shown), then a refused invite (link
  gone). Removing `setIssuedLink(null)` fails it.
- Modified file: `src/components/team/members/__tests__/team-invite-by-email-section.test.tsx`
