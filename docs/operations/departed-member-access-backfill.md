# Departed members that kept team access (#1033)

Two backfills shipped with `20261101000000_team_tenant_departure` and
`20261104000000_team_key_rotation_rekey` set no row-level-security bypass. Every
table they touch is under FORCE RLS, so on a migrate role without `BYPASSRLS`
(an RDS or Cloud SQL admin, a managed-Postgres admin: check `rolsuper` and
`rolbypassrls` in `pg_roles`) they changed nothing. Memberships of members who
left their tenant before that release stayed active, and team authorization
reads only `team_members`, so those members kept their team-entry access and
admin browsers kept distributing rotated team keys to them.
`20261110000000_rls_backfill_rerun` ends those memberships on a role that cannot
bypass RLS. On a role that bypasses it the original already ran with effect, and
the re-run skips (it logs a warning with a count).

This page applies to every deployment that applied `20261101000000` before
`20261110000000`, whatever its migrate role or host history. Both scripts below
grant themselves the bypass transaction-locally (RLS is granted by settings, not
by a role attribute), so they run as the same admin that runs `prisma migrate
deploy`. Run them with `psql -v ON_ERROR_STOP=1 -f <file>`.

## Steps

**Before deploying `20261110000000`**

1. Run the report. Keep the output.
2. Disable the team webhooks listed in its section 2. The migration ends
   memberships, not webhook-based access, and its audit rows fan out to
   webhooks.

**After deploying it**

3. Run the report again and keep its output. The records it relies on are purged
   by audit retention, and the shortest tenant retention bounds how long the
   report can rebuild the list.
4. On a migrate role without `BYPASSRLS` the migration ended every candidate that
   had no deactivation record. Section 1 now lists the candidates it kept because
   a record exists (`has_deactivation_record`): normally a re-admission, or a
   departure processed by a previous-release instance during the rollout. On a
   role that bypasses RLS it skipped all of them, so section 1 lists every one.
5. Send each tenant's admin only their tenant's rows. The admin confirms each
   one. For an admission before `20261114000000_team_member_admitted_at`, no
   audit evidence distinguishes a re-admission from a leak: invitation accept
   wrote no audit row then, and an ACCEPTED invitation is not evidence. From
   that release on, a re-admission is evidenced (see "Re-admission evidence"
   below) and moves `team_members.admitted_at` past the departure, which takes
   the membership out of section 1.
6. End the confirmed leaks with the contain script. Pass only rows whose
   `containable` is true: one row it cannot end makes the script refuse the
   whole batch. A `containable` false row (the tenant row was deleted, or
   re-created after a SCIM DELETE) is ended by a team admin removing the member;
   the member already cannot act (see "Actors refused since this release"). If
   that member is the team's OWNER, nobody can remove them: the team counts as
   ownerless, so the tenant admin first assigns a new OWNER (the leftover row is
   demoted to ADMIN by that assignment), and the new OWNER then removes them.

**For every membership the migration or the contain script ended** (found by
`TEAM_MEMBER_TENANT_DEACTIVATE` records whose `metadata.backfill` is
`20261110000000_rls_backfill_rerun`, in `audit_logs` and in `audit_outbox`;
section 2 of the report is built from them), in this order:

1. Disable the webhooks section 2 lists for the team.
2. If no active OWNER or ADMIN of the team holds the team key
   (`key_distributed`): when the team has no active OWNER, the tenant admin
   assigns one, choosing a member whose tenant row is active and who holds the
   key (check `key_distributed` yourself; the route does not). When an active
   OWNER without the key exists, that OWNER promotes a key holder to ADMIN. If
   neither is possible the team cannot be rotated: tell the tenant admin why,
   and only steps 4 to 6 apply.
3. Rotate the team key and run the re-key pass.
4. Rotate, at their services, the secrets held in those teams' entries.
5. Review the member's team-scope audit rows in the leak window, from the
   record's `metadata.departedAt` to the record, and revert what they did.
   Export them first: audit retention purges them.
6. Tell each affected tenant's admin.

Team-entry share links the member created stop being served on their own
(`share_creator_admitted`). A legitimately re-admitted member the migration ended
is re-invited. That includes a member the original ended on a role that
bypassed RLS and who was re-admitted since, when the re-run later ran on a role
that cannot bypass: the re-admission left no record, so the migration revoked it.

## Team absolute session timeouts (`20260418042050`)

An older migration has the same defect and cannot be re-run.
`20260418042050_unify_session_timeout_policy` copied each team's legacy
`max_session_duration_minutes` into the new `session_absolute_timeout_minutes`
override. On a migrate role without `BYPASSRLS` over existing data that copy saw
no rows, so those teams' overrides stayed empty and the teams inherit the
tenant's absolute session timeout, which may be longer. The source column was
dropped by `20260425103520`, so the old values are not in the database.

If the deployment applied `20260418042050` that way, tell each tenant admin to
check the absolute session timeout of every team that had a stricter session
duration before that release and set it again in the team's policy.

## Report

Read-only (`BEGIN READ ONLY` ... `ROLLBACK`). It raises
`report: no tenant_members rows are visible` instead of returning an empty
report when the grant did not take effect.

- Section 1: the raw candidates, with no exclusion: active memberships whose
  member departed the tenant at or after the membership's admission (tenant,
  team, user, role, and whether the user has a deactivation record in either
  store). Admission is `COALESCE(admitted_at, created_at)`; the departure is
  the later of the tenant row's `deactivated_at` and the SCIM DELETE record in
  `tenant_member_departures`, so a member whose tenant row was deleted, or
  re-created after a SCIM DELETE, is listed too. This is the predicate the
  application's actor check uses (see "Actors refused since this release").
  `containable` says whether the contain script can end the row: it needs a
  departed tenant row to stamp the membership with.
- Section 2: the team webhooks, columns `id, tenant_id, team_id, is_active,
  created_at, updated_at` only (never `url`, secrets or `last_error`). For a
  candidate's team, the webhooks created or updated after the candidate's
  departure. For a team that holds a membership ended by the migration or the
  contain script, every webhook of the team, with no time filter (the member
  may have returned, left again, or had the tenant row deleted since;
  over-inclusion fails closed).
- Section 3: the team webhooks with no recorded creator (`created_by_id` NULL),
  columns `id, tenant_id, team_id, is_active, created_at, creator,
  creator_active_member`. `creator` is the actor of the webhook's latest
  `WEBHOOK_CREATE` record (`audit_logs`, else a not-yet-drained `audit_outbox`
  row), or `unknown`; `creator_active_member` says whether that user holds an
  active membership of the webhook's team. These webhooks keep delivering
  whatever happens to their creator (see "Paused team webhooks"): review each
  one, and re-create under a current team admin any whose creator is unknown or
  no longer an active member.

```sql
-- BEGIN SCRIPT departed-member-report
BEGIN READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true);
SELECT set_config('app.bypass_tables', 'tenant_members,tenant_member_departures,team_members,team_webhooks,audit_logs,audit_outbox', true);
SELECT set_config('app.bypass_purpose', 'system_maintenance', true);
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
-- BEGIN BODY report
DO $control$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_members) THEN
    RAISE EXCEPTION 'report: no tenant_members rows are visible; the bypass grant did not take effect';
  END IF;
END
$control$;

-- Section 1: candidates
SELECT tm.tenant_id, tm.team_id, tm.user_id, tm.role,
       (EXISTS (SELECT 1 FROM audit_logs a
                 WHERE a.tenant_id = tm.tenant_id
                   AND a.action = 'TEAM_MEMBER_TENANT_DEACTIVATE'
                   AND a.target_id = tm.user_id::text)
        OR EXISTS (SELECT 1 FROM audit_outbox o
                    WHERE o.tenant_id = tm.tenant_id
                      AND o.payload->>'action' = 'TEAM_MEMBER_TENANT_DEACTIVATE'
                      AND o.payload->>'targetId' = tm.user_id::text)) AS has_deactivation_record,
       (tmb.deactivated_at IS NOT NULL) AS containable
  FROM team_members tm
  LEFT JOIN tenant_members tmb ON tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
  LEFT JOIN tenant_member_departures d ON d.tenant_id = tm.tenant_id AND d.user_id = tm.user_id
 WHERE tm.deactivated_at IS NULL
   AND COALESCE(tm.admitted_at, tm.created_at) <= GREATEST(tmb.deactivated_at, d.departed_at)
 ORDER BY tm.tenant_id, tm.team_id, tm.user_id;

-- Section 2: webhooks
SELECT DISTINCT w.id, w.tenant_id, w.team_id, w.is_active, w.created_at, w.updated_at
  FROM team_webhooks w
 WHERE EXISTS (
         SELECT 1
           FROM team_members tm
           LEFT JOIN tenant_members tmb ON tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
           LEFT JOIN tenant_member_departures d ON d.tenant_id = tm.tenant_id AND d.user_id = tm.user_id
          WHERE tm.team_id = w.team_id
            AND tm.tenant_id = w.tenant_id
            AND tm.deactivated_at IS NULL
            AND COALESCE(tm.admitted_at, tm.created_at) <= GREATEST(tmb.deactivated_at, d.departed_at)
            AND (w.created_at > GREATEST(tmb.deactivated_at, d.departed_at)
                 OR w.updated_at > GREATEST(tmb.deactivated_at, d.departed_at)))
    OR EXISTS (
         SELECT 1 FROM audit_logs a
          WHERE a.tenant_id = w.tenant_id
            AND a.team_id = w.team_id
            AND a.action = 'TEAM_MEMBER_TENANT_DEACTIVATE'
            AND a.metadata->>'backfill' = '20261110000000_rls_backfill_rerun')
    OR EXISTS (
         SELECT 1 FROM audit_outbox o
          WHERE o.tenant_id = w.tenant_id
            AND o.payload->>'teamId' = w.team_id::text
            AND o.payload->>'action' = 'TEAM_MEMBER_TENANT_DEACTIVATE'
            AND o.payload->'metadata'->>'backfill' = '20261110000000_rls_backfill_rerun')
 ORDER BY w.tenant_id, w.team_id, w.id;

-- Section 3: webhooks with no recorded creator
SELECT w.id, w.tenant_id, w.team_id, w.is_active, w.created_at,
       COALESCE(c.actor::text, 'unknown') AS creator,
       (c.actor IS NOT NULL AND EXISTS (
          SELECT 1 FROM team_members tm
           WHERE tm.team_id = w.team_id
             AND tm.user_id = c.actor
             AND tm.deactivated_at IS NULL)) AS creator_active_member
  FROM team_webhooks w
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             (SELECT a.user_id
                FROM audit_logs a
               WHERE a.action = 'WEBHOOK_CREATE'
                 AND a.scope = 'TEAM'
                 AND a.actor_type = 'HUMAN'
                 AND a.tenant_id = w.tenant_id
                 AND a.team_id = w.team_id
                 AND a.metadata->>'webhookId' = w.id::text
               ORDER BY a.created_at DESC
               LIMIT 1),
             (SELECT (o.payload->>'userId')::uuid
                FROM audit_outbox o
               WHERE o.tenant_id = w.tenant_id
                 AND o.payload->>'action' = 'WEBHOOK_CREATE'
                 AND o.payload->>'scope' = 'TEAM'
                 AND o.payload->>'actorType' = 'HUMAN'
                 AND o.payload->>'teamId' = w.team_id::text
                 AND o.payload->'metadata'->>'webhookId' = w.id::text
               ORDER BY o.created_at DESC
               LIMIT 1)) AS actor
  ) c ON true
 WHERE w.created_by_id IS NULL
 ORDER BY w.tenant_id, w.team_id, w.id;
-- END BODY report
ROLLBACK;
-- END SCRIPT departed-member-report
```

## Contain

Ends the confirmed leaks. Edit only the two lines marked `INPUT`:

- the triples `{tenant_id, team_id, user_id}`, one row per membership, as a
  `uuid` array (a malformed id raises at the cast before any lock is taken);
- the operator label, a free-text name for who ran it (1 to 255 characters, not
  the template). The label is written to the audit records, so tenant admins and
  webhook receivers see it: it must hold no personal data.

A membership is ended only when its team, membership and tenant row all belong
to the given tenant, the membership is active, the member's tenant row is
departed, and the membership was admitted (`COALESCE(admitted_at, created_at)`)
at or before the departure: a member re-admitted since is not a leak, and the
script refuses the triple. It is stamped with the tenant row's departure time and marked as ended
by the tenant, so a later return restores it. If any triple does not qualify,
the script raises and writes nothing. An OWNER membership is ended the same way;
the team then has no active OWNER, and the tenant admin's owner-assign flow
applies (step 2 above). Duplicate triples are collapsed. Each ended membership
gets the same audit record as the migration's, with `metadata.manual` true and
`metadata.operator` the label; your database user goes only to a notice in your
own session.

```sql
-- BEGIN SCRIPT departed-member-contain
BEGIN;
DO $contain$
DECLARE
  v_input uuid[] := '{{tenant-uuid,team-uuid,user-uuid}}'::uuid[]; -- INPUT:triples
  v_label text := $label$REPLACE-WITH-OPERATOR-LABEL$label$; -- INPUT:label
  v_tenants uuid[];
  v_teams uuid[];
  v_users uuid[];
  v_input_count integer;
  v_ended integer;
  v_enqueued integer;
BEGIN
  IF array_ndims(v_input) IS DISTINCT FROM 2 OR array_length(v_input, 2) IS DISTINCT FROM 3
     OR COALESCE(array_length(v_input, 1), 0) < 1 THEN
    RAISE EXCEPTION 'contain: the input must be a two-dimensional uuid array of (tenant_id, team_id, user_id) rows, at least one';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_input) AS x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'contain: the input holds a null id';
  END IF;
  IF v_label IS NULL OR btrim(v_label) = '' OR length(v_label) > 255 OR v_label = 'REPLACE-WITH-OPERATOR-LABEL' THEN
    RAISE EXCEPTION 'contain: the operator label must be 1 to 255 characters and not the template';
  END IF;

  SELECT array_agg(d.t ORDER BY d.t, d.m, d.u), array_agg(d.m ORDER BY d.t, d.m, d.u),
         array_agg(d.u ORDER BY d.t, d.m, d.u), count(*)
    INTO v_tenants, v_teams, v_users, v_input_count
    FROM (
      SELECT DISTINCT v_input[g.i][1] AS t, v_input[g.i][2] AS m, v_input[g.i][3] AS u
        FROM generate_subscripts(v_input, 1) AS g(i)
    ) d;

  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables', 'tenant_members,tenant_member_departures,teams,team_members,audit_outbox', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  -- The app's order (src/lib/team/tenant-row-lock.ts): advisory lock per
  -- (tenant, user) in byte order of the key, then the tenant rows, then teams.
  PERFORM pg_advisory_xact_lock(hashtext(k))
    FROM (
      SELECT k FROM (
        SELECT DISTINCT 'tenant-member:' || d.t::text || ':' || d.u::text AS k
          FROM unnest(v_tenants, v_users) AS d(t, u)
      ) AS keys
       ORDER BY k COLLATE "C"
    ) ordered;

  PERFORM 1
    FROM tenant_members tmb
    JOIN (SELECT DISTINCT d.t, d.u FROM unnest(v_tenants, v_users) AS d(t, u)) i
      ON i.t = tmb.tenant_id AND i.u = tmb.user_id
   ORDER BY tmb.tenant_id, tmb.user_id
     FOR UPDATE OF tmb;

  PERFORM 1 FROM teams WHERE id = ANY (v_teams) ORDER BY id FOR SHARE;

  WITH ended AS (
    UPDATE team_members tm
       SET deactivated_at = tmb.deactivated_at,
           deactivated_by_tenant = true,
           updated_at = clock_timestamp()
      FROM unnest(v_tenants, v_teams, v_users) AS i(tenant_id, team_id, user_id),
           tenant_members tmb
           LEFT JOIN tenant_member_departures d ON d.tenant_id = tmb.tenant_id AND d.user_id = tmb.user_id
     WHERE tm.tenant_id = i.tenant_id
       AND tm.team_id = i.team_id
       AND tm.user_id = i.user_id
       AND tmb.tenant_id = i.tenant_id
       AND tmb.user_id = i.user_id
       AND tm.deactivated_at IS NULL
       AND tmb.deactivated_at IS NOT NULL
       AND COALESCE(tm.admitted_at, tm.created_at) <= GREATEST(tmb.deactivated_at, d.departed_at)
    RETURNING tm.tenant_id, tm.team_id, tm.user_id, tmb.deactivated_at AS departed_at
  ), enqueued AS (
    INSERT INTO audit_outbox (id, tenant_id, payload)
    SELECT gen_random_uuid(), e.tenant_id,
           jsonb_build_object(
             'scope', 'TEAM',
             'action', 'TEAM_MEMBER_TENANT_DEACTIVATE',
             'userId', '00000000-0000-4000-8000-000000000001',
             'actorType', 'SYSTEM',
             'serviceAccountId', NULL,
             'teamId', e.team_id,
             'targetType', 'TeamMember',
             'targetId', e.user_id,
             'metadata', jsonb_build_object(
               'source', 'TENANT_DEACTIVATION',
               'backfill', '20261110000000_rls_backfill_rerun',
               'departedAt', to_char(e.departed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'manual', true,
               'operator', v_label),
             'ip', NULL,
             'userAgent', NULL)
      FROM ended e
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ended), (SELECT count(*) FROM enqueued) INTO v_ended, v_enqueued;

  IF v_ended IS DISTINCT FROM v_input_count THEN
    RAISE EXCEPTION 'contain: % of % membership(s) qualify (team, membership and tenant row of one tenant; active; member departed; admitted before the departure); nothing was written',
      v_ended, v_input_count;
  END IF;

  RAISE NOTICE 'contain: ended % membership(s) as database user %', v_ended, session_user;
END
$contain$;
COMMIT;
-- END SCRIPT departed-member-contain
```

## Re-admission evidence

From `20261114000200_team_member_invite_accept_audit_action` on, invitation
accept writes `TEAM_MEMBER_INVITE_ACCEPT` (scope TEAM, target the invitee) in
the admission's own transaction, with `metadata.readmitted` true when an
existing membership row was re-activated and false when one was created. An
already-active member accepting writes none. A `readmitted: true` record later
than the member's departure is evidence of a re-admission, as is
`team_members.admitted_at` later than the departure: the database stamps
`admitted_at` on every re-activation of a row and the application cannot set it.

## Actors refused since this release

Inviting, accepting an invitation the actor issued, adding a member, approving
a SCIM-pending member, changing a role or transferring ownership, and
distributing the team key all refuse an actor who departed the tenant at or
after their admission to the team, even while their membership row is still
active (the residue section 1 lists). The refusal is the route's usual one (403,
or `INVITATION_EXPIRED` for accept). Rotating the team key refuses such an actor
too.

The same membership is also refused as a **recipient**: it is not given the team
key (confirm-key answers `MEMBER_NOT_FOUND`), not promoted, and never made OWNER;
a demotion is still allowed. A team key rotation does not wrap the new version
for it and clears its `key_distributed`, so it holds only keys it already had.
The team's pending key distributions still list it, and an admin's browser keeps
being refused until the membership is ended. A team admin who tries to promote
such a member, transfer ownership to them, or give them the key sees "member not
found" for a member the team list still shows: that is this refusal. End the
membership (or remove the member and invite them again if they belong in the
team).

This also refuses a member who was legitimately re-admitted **before**
`20261114000000_team_member_admitted_at`: their row has no `admitted_at`, its
`created_at` predates the departure, and nothing tells that apart from residue.
Such a member appears in section 1. Recovery is a re-admission: once the tenant
admin confirms the member, a team admin removes them and invites them again (or
a SCIM return restores them); the new admission stamps `admitted_at` and their
authority comes back. Do not edit `admitted_at`: the trigger ignores it.

## Paused team webhooks

A team webhook is delivered only while its creator holds an active membership
of the webhook's team with a role that may update the team (OWNER or ADMIN).
Once the creator is removed, departs, or is demoted, delivery is skipped (not
counted as a failure), and the team's webhook settings show the webhook as
paused. Events from the gap are not delivered later; delivery resumes for new
events when the creator's authority returns. To keep a paused webhook's stream,
a current team admin re-creates it (and the old one is deleted).

A webhook created before `20261114000300_team_webhook_creator` has a creator
only if the migration found its `WEBHOOK_CREATE` record; otherwise it keeps
delivering as before, and section 3 of the report lists it. A creator whose
membership row survived their departure (the residue section 1 lists) still
passes the delivery check: end that membership with the contain script.

## What prevents a recurrence, and its limits

Departures end memberships because every departure writer lives in
`src/lib/team/team-departure.ts` and calls `endTeamMemberships` there. That is
a convention reviewed by humans. The `check-team-rotation-input-lock` gate fails
a write to `tenant_members.deactivated_at` outside that file, but it does not
see the file's own writers, `*Unsafe` raw SQL, aliased receivers, `scripts/`, or
deletes of tenant rows. A tenant-row change made any other way (a hand-written
`UPDATE`, a script) can leave memberships active again: run the report after
any such change. The actor check above refuses such residue at the six admission
sites, and share links stop on their own; webhook delivery reads only the team
row, so the report and the contain script remain the control there.
