# Manual Test: departed-member-leaked-authority

Issue `#1035`. Plan: `departed-member-leaked-authority-plan.md`.

Tier: **R35 Tier-2 (authorization and webhook delivery)**. The real-DB integration suite
(`departed-member-leaked-authority`, `share-departure`, `departed-member-operator-scripts`)
covers every acceptance cell. This walk-through checks the same behaviour end to end in a
browser, through the real SCIM endpoint and a running outbox worker.

## Pre-conditions

- Dev stack up (`npm run docker:up`), migrations applied through
  `20261114000300_team_webhook_creator` (`npm run db:migrate`), app on its dev port, and the
  `audit-outbox-worker` container **running** (delivery is under test here).
- One tenant with SCIM enabled and a SCIM token (`/dashboard/tenant` → SCIM tokens).
- Four users with vaults set up, all signed in through SSO in separate browser profiles:
  - **Owner**: tenant OWNER, OWNER of team **T**;
  - **Alice**: tenant MEMBER, team **T** ADMIN, holds the team key;
  - **Bob**: tenant MEMBER, team **T** MEMBER;
  - **Carol**: tenant MEMBER, not in **T**.
- A webhook receiver reachable over HTTPS from the app (for example a request-bin service);
  note its URL as `$HOOK`.
- A superuser SQL session (`MIGRATION_DATABASE_URL`) for the read-backs. Every read-back below
  runs inside `BEGIN; SELECT set_config('app.bypass_rls','on',true),
  set_config('app.bypass_tables','team_members,tenant_members,team_webhooks,audit_outbox,password_shares',true),
  set_config('app.bypass_purpose','system_maintenance',true); … ROLLBACK;`.
- SCIM helper:

  ```bash
  scim_active() { curl -sS -X PATCH "$APP/api/scim/v2/Users/$1" \
    -H "Authorization: Bearer $SCIM_TOKEN" -H 'Content-Type: application/scim+json' \
    -d "{\"schemas\":[\"urn:ietf:params:scim:api:messages:2.0:PatchOp\"],\"Operations\":[{\"op\":\"replace\",\"path\":\"active\",\"value\":$2}]}" \
    -o /dev/null -w '%{http_code}\n'; }
  ```

## Steps and expected results

1. **Webhook creator recorded.** As Alice, team T → Settings → Webhooks, create a webhook to
   `$HOOK` subscribed to entry create.
   - `SELECT created_by_id FROM team_webhooks WHERE url = '<$HOOK>'` → Alice's user id.
   - As Owner, the webhook list shows it as active (no paused notice).
2. **Delivery while authorized.** As Owner, create a team entry in T. Within a few seconds the
   receiver gets one POST with `type` = `ENTRY_CREATE` and `teamId` = T.
3. **Demotion pauses the webhook.** As Owner, change Alice's role in T to MEMBER.
   - The webhook card shows the localized "paused: its creator no longer has access" state.
   - Create another team entry: the receiver gets nothing. The worker log shows
     `outbox.webhook_creator_unauthorized` for the webhook.
   - `SELECT status, last_error, attempt_count FROM webhook_deliveries WHERE team_id = '<T>'
     ORDER BY created_at DESC LIMIT 1` → `SENT`, NULL, 0; the webhook's `fail_count` is 0.
4. **Re-promotion resumes it.** Promote Alice back to ADMIN. The paused notice disappears.
   Create an entry: one POST arrives. The event from step 3 is **not** delivered.
5. **Departure pauses it; return resumes it.** `scim_active <alice> false` → `200`.
   - The webhook card shows paused; an entry created now is not delivered.
   - Alice's T membership: `deactivated_at` set, `deactivated_by_tenant` true.
   - `scim_active <alice> true` → `200`; the paused notice disappears, a new entry is
     delivered, and Alice's row has `admitted_at` set to the return time.
6. **Re-admission is audited.** `scim_active <bob> false`. As Owner, invite Bob to T again (as
   MEMBER). Bob accepts in his browser.
   - The accept succeeds; Bob's T row is the same row (`id` unchanged), active, with
     `admitted_at` after the departure and `key_distributed` false.
   - `SELECT payload FROM audit_outbox WHERE payload->>'action' = 'TEAM_MEMBER_INVITE_ACCEPT'
     ORDER BY created_at DESC LIMIT 1` → `targetId` Bob, `metadata` `{invitationId, role:
     "MEMBER", readmitted: true}`. Once the worker drains it, the team audit log shows the
     action with its label and icon.
7. **A re-admitted member keeps their new authority.** As Owner, promote Bob to ADMIN and
   distribute the key to him. As Bob, invite Carol to T → succeeds (201).
8. **Already-active accept.** As Owner, issue an invitation to Carol; insert a second PENDING
   invitation for her by SQL only after she has accepted the first. Accepting the second →
   success with "already a member"; no second `TEAM_MEMBER_INVITE_ACCEPT` row.

## Adversarial scenarios

- **Departed inviter tries invite and accept.** Make Alice residue: as superuser,
  `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = '<alice>' AND tenant_id =
  '<tenant>'` (exactly one row), leaving her T row active. Then:
  - Alice invites anyone to T → 403; no invitation row.
  - Insert a PENDING invitation from Alice to Carol by SQL, after the UPDATE. Carol accepts →
    "invitation expired" (410); the invitation becomes EXPIRED; Carol is not admitted.
  - Alice adds a member, approves a SCIM-pending member, changes Bob's role, or distributes
    the key → 403 each, nothing changes.
  - Report section 1 (`docs/operations/departed-member-access-backfill.md`) lists Alice's T row.
- **Residue admin promotes a member.** With Alice still residue, as Alice change Bob's role to
  VIEWER → 403; Bob's role unchanged. If Alice were OWNER, a transfer to Bob → 403.
- **Departed creator's webhook.** Alice (residue) created the step 1 webhook: it still
  delivers, because delivery reads only the team row (plan C6 dependency). The runbook's
  contain script ends her T row; after that the webhook shows paused and an entry is not
  delivered.
- **Re-admitted user's old share link.** Before step 6, as Bob, create a share link for a T
  entry and open it in a private window (served). After step 6 (departure and accept on the
  same row), the old link answers "revoked"; a link Bob creates after the accept is served.
- **Legacy NULL-creator webhook.** `UPDATE team_webhooks SET created_by_id = NULL WHERE id =
  '<webhook>'`. The card shows no paused state (the API's `creatorAuthorized` is null), it is
  delivered whatever Alice's state, and report section 3 lists it with its `WEBHOOK_CREATE`
  actor (or `unknown`) and whether that actor is an active member.

## Rollback

- Restore Alice's tenant row: `UPDATE tenant_members SET deactivated_at = NULL WHERE user_id =
  '<alice>' AND tenant_id = '<tenant>'` (or `scim_active <alice> true` for a SCIM departure).
- Delete the test webhook and the test share links from the UI; remove Carol from T.
- `scim_active <bob> true` if Bob is still departed.
- No schema rollback is part of this test. Reverting the release's code would leave
  `team_members.admitted_at`, its trigger, `team_webhooks.created_by_id` and the worker's
  column grant in place, unused by the previous code. `share_creator_admitted` keeps the C3
  rule, so a departed creator's earlier shares stay refused.
