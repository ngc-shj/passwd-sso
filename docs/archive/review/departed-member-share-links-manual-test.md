# Manual Test: departed-member-share-links

Issue `#990`. Plan: `departed-member-share-links-plan.md`. A share link for a team
entry stops serving once its creator no longer holds the membership of the entry's
team they held when they created it, or the entry is trashed or gone.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied (`npm run db:migrate`), dev
  server running.
- A tenant with an IdP SCIM token, and three users: an OWNER, a MEMBER "creator", and
  another member. A team whose members are the OWNER and the creator, holding one
  login entry.
- A second browser profile (or a private window) for the link recipient.

## Steps and expected results

1. As the creator, share the team entry twice: once without a password, once with
   one. Open both links as the recipient.
   - Expected: the first shows the entry; the second asks for the password and then
     shows it.
2. Deactivate the creator through SCIM (`PATCH /api/scim/v2/Users/<id>`, `active=false`).
   Reload both links as the recipient.
   - Expected: both show "This link has been revoked" — the same screen as a link the
     creator revoked. The protected link does not show its password prompt.
3. As the OWNER, open Share links (team view).
   - Expected: both links carry "Unavailable: the creator left the team or the entry was
     removed" ("利用不可：作成者がチームを離れたか、エントリが削除されました").
4. Reactivate the creator through SCIM (`active=true`). Reload both links.
   - Expected: both serve again.
5. Remove the creator from the team (Members → Remove). Reload the links.
   - Expected: revoked screen. Re-invite the creator and accept as them; reload.
   - Expected: still the revoked screen (a new membership does not revive links).
6. Move the entry to the trash, reload; restore it, reload.
   - Expected: revoked screen while trashed; the link serves again after restore.
7. As any user, share a personal entry and a text Send; remove that user from a team.
   - Expected: the personal link and the Send keep working.

## Adversarial scenarios

- A recipient who opened the link before the creator left already holds the data:
  refusal stops further retrieval only. Rotate the shared credential — the operator
  remedy for a departed member's links.
- Try a wrong password on a dead protected link (`POST /api/share-links/verify-access`).
  - Expected: 404, the same as a revoked link; no `SHARE_ACCESS_VERIFY_FAILED` audit row.
- Call `GET /api/share-links/<id>/content` with a still-valid access token minted before
  the departure.
  - Expected: 404; `view_count` does not change.

## Rollback

Revert the branch; then drop the constraint and the function:
`ALTER TABLE password_shares DROP CONSTRAINT password_shares_team_share_client_encrypted;`
`DROP FUNCTION public.share_creator_admitted(uuid);` (and remove the two
`_prisma_migrations` rows). Links then serve as before the change.
