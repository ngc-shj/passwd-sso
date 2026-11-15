# Manual Test: team-invitation-token-digest

Issue `#1054`. Review log: `team-invitation-token-digest-code-review.md`.

Tier: **R35 Tier-1 (admin UI)**, with a stored-secret change underneath. The real-DB
integration cells (`team-tenant-departure.integration.test.ts`, describe `A0`) cover storage,
accept and the migration over an old-shape row. This walk-through checks the admin flow in a
browser.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied through
  `20261115100000_team_invitation_token_digest` (`npm run db:migrate`), app on its dev port.
- Two users with vaults set up, signed in in separate browser profiles:
  - **Owner**: OWNER of team **T** (signed in to the admin console);
  - **Dana**: no membership of **T**; her email is `$DANA`.
- A superuser SQL session (`MIGRATION_DATABASE_URL`) for the read-backs. Each read-back runs
  inside `BEGIN; SELECT set_config('app.bypass_rls','on',true),
  set_config('app.bypass_tables','team_invitations',true),
  set_config('app.bypass_purpose','system_maintenance',true); … ROLLBACK;`.

## Steps and expected results

1. **The link is shown once, with its invitee.** As Owner, admin console → teams → **T** →
   members → Add member. Under "Invite by email", enter `$DANA`, role Member, send.
   - The dialog stays open. Below the form: "Invite link for `$DANA`. Copy it now — it won't
     be shown again.", a read-only field holding `…/dashboard/teams/invite/<64 hex>`, and a
     copy button.
   - The toast says the invite URL was copied (or, if the browser refused the clipboard, to
     copy the link below). No "Failed to send invitation" toast.
   - The pending-invitations list shows `$DANA` with a cancel button and **no** copy-link button.
   - Note the token from the field as `$T`.
2. **Only the digest is stored.**
   `SELECT token_hash FROM team_invitations WHERE email = '<$DANA>' AND status = 'PENDING'`
   → equals `printf %s "$T" | sha256sum`; `$T` itself appears in no column of the row.
3. **The link is gone after closing.** Close the dialog and reopen it: no link is shown.
   Sending a second invite to `$DANA` answers "already invited" and shows no link.
4. **Accept by the link.** As Dana, open `…/dashboard/teams/invite/$T` (it accepts
   automatically once her vault is unlocked).
   - Dana joins **T**; the invitation's status becomes `ACCEPTED`.
5. **The digest is not a token.** As Owner, invite another address and read its `token_hash`.
   As Dana (any signed-in user with an unlocked vault: the lookup refuses before the email is
   compared), open `…/dashboard/teams/invite/<token_hash>`.
   - Refused as an invalid invitation; the row stays `PENDING`.
6. **Non-secure origin (optional).** Open the admin console over plain HTTP on a LAN address
   (no `navigator.clipboard`), invite a third address.
   - The invitation is reported as sent and the link is shown to copy by hand; no failure toast.

## Rollout note

Deploying this migration while instances of the previous release run makes invitation issue,
list, cancel and accept fail on those instances until they are replaced (owner decision; see
`scripts/checks/destructive-migration-baseline.txt`). Expect such errors only during the rollout.
