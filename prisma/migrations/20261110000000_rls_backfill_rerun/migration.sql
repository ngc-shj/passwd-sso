-- Re-run of two backfills that set no RLS bypass (#1033). Every table they
-- read or write is under FORCE RLS, so on a migrate role without BYPASSRLS
-- (RDS's master, a managed-Postgres admin) each statement saw no rows and
-- the backfill did nothing, while a superuser (compose, CI) was green:
--
--  * 20261101000000_team_tenant_departure: memberships of members who left
--    the tenant before that change stayed active.
--  * 20261104000000_team_key_rotation_rekey: entries stayed pending re-key
--    and without an ItemKey id / high-water.
--
-- The originals are checksummed and stay as they are. Each block below grants
-- itself the bypass for exactly the tables it references, transaction-locally,
-- and restores the previous settings after (20261109162613 is the precedent).
-- app.tenant_id is the nil UUID so the policies' tenant arm casts cleanly.
--
-- Wrapped in BEGIN/COMMIT: the blocks are two DO statements
-- (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

-- BEGIN BACKFILL team-tenant-departure-rerun
-- Runs only when the migrate role cannot bypass RLS (current_user has neither
-- rolsuper nor rolbypassrls; neither attribute is inherited). On a role that
-- bypasses RLS the original ran with effect and wrote no deactivation record,
-- so the exclusion below would have no evidence and a re-run would revoke
-- members re-admitted since.
--
-- Locks follow the app's order (src/lib/team/tenant-row-lock.ts):
-- advisory lock per (tenant, user) -> tenant_members rows -> tenant_member_departures
-- -> teams -> team_invitations -> team_members. The statements are reordered
-- against the original (2c's record insert before the invitation updates, step 1
-- last); none reads another's write, so the results are the original's.
DO $backfill$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_can_bypass boolean;
  v_cand_tenants uuid[];
  v_cand_users uuid[];
  n_memberships integer := 0;
  n_outbox integer := 0;
  n_inviter integer := 0;
  n_invitee integer := 0;
  n_records integer := 0;
  n_deleted_invitee integer := 0;
  n_ownerless integer := 0;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables',
    'tenant_members,tenant_member_departures,teams,team_invitations,team_members,users,audit_logs,audit_outbox', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;

  -- The step-1 candidates: active memberships of members who departed, created
  -- before the departure, whose user has no TEAM_MEMBER_TENANT_DEACTIVATE record
  -- in that tenant (any team, any time; audit_logs or audit_outbox, any status).
  -- Only endTeamMemberships writes that action, in the transaction that ends
  -- every active membership of the user in the tenant, so with a record an
  -- active membership was re-admitted after the last departure. No time
  -- conjunct: the record's created_at and the stamp come from different clocks.
  -- Text comparisons: audit_logs.target_id holds non-UUID targets.
  SELECT COALESCE(array_agg(c.tenant_id), '{}'), COALESCE(array_agg(c.user_id), '{}')
    INTO v_cand_tenants, v_cand_users
    FROM (
      SELECT DISTINCT tm.tenant_id, tm.user_id
        FROM team_members tm
        JOIN tenant_members tmb ON tmb.tenant_id = tm.tenant_id AND tmb.user_id = tm.user_id
       WHERE tm.deactivated_at IS NULL
         AND tmb.deactivated_at IS NOT NULL
         AND tm.created_at < tmb.deactivated_at
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs a
            WHERE a.tenant_id = tm.tenant_id
              AND a.action = 'TEAM_MEMBER_TENANT_DEACTIVATE'
              AND a.target_id = tm.user_id::text)
         AND NOT EXISTS (
           SELECT 1 FROM audit_outbox o
            WHERE o.tenant_id = tm.tenant_id
              AND o.payload->>'action' = 'TEAM_MEMBER_TENANT_DEACTIVATE'
              AND o.payload->>'targetId' = tm.user_id::text)
    ) c;

  IF v_can_bypass THEN
    RAISE WARNING 'team-tenant-departure-rerun skipped: the migrate role bypasses RLS and the original ran with effect; % departed member(s) still hold active memberships (see the operator runbook)',
      cardinality(v_cand_users);
  ELSE
    -- Advisory lock per (tenant, user) for the candidates and for the 2c
    -- subjects (SCIM-deleted users have no tenant row; the advisory lock is
    -- what serialises them with invitation accept). The key expression and the
    -- byte order are lockTenantRows'.
    PERFORM pg_advisory_xact_lock(hashtext(k))
      FROM (
        SELECT k FROM (
          SELECT 'tenant-member:' || s.tenant_id::text || ':' || s.user_id::text AS k
            FROM (
              SELECT c.tenant_id, c.user_id FROM unnest(v_cand_tenants, v_cand_users) AS c(tenant_id, user_id)
              UNION
              SELECT a.tenant_id, a.target_id::uuid
                FROM audit_logs a
                JOIN users u ON u.id::text = a.target_id
               WHERE a.action = 'SCIM_USER_DELETE'
            ) s
        ) AS keys
         ORDER BY k COLLATE "C"
      ) ordered;

    -- The candidates' tenant rows, FOR SHARE OF that table only (never the
    -- joined team_members rows, which would precede teams): a concurrent
    -- returnToTenant waits, then restores what this block marked.
    PERFORM 1
      FROM tenant_members tmb
      JOIN unnest(v_cand_tenants, v_cand_users) AS c(tenant_id, user_id)
        ON c.tenant_id = tmb.tenant_id AND c.user_id = tmb.user_id
     ORDER BY tmb.tenant_id, tmb.user_id
       FOR SHARE OF tmb;

    -- 2c. SCIM DELETEs before 20261101000000 left no row; seed their departure
    --     records from the latest SCIM_USER_DELETE audit row per (tenant, user)
    --     (best effort: retention may have purged it; the audit created_at is
    --     the outbox time, slightly after the delete, which fails closed).
    --     DO NOTHING: an existing record was written by the app at the delete;
    --     overwriting it with the audit time would move a departure later and
    --     could void invitations issued in between.
    INSERT INTO tenant_member_departures (tenant_id, user_id, departed_at)
    SELECT a.tenant_id, a.target_id::uuid, max(a.created_at)
      FROM audit_logs a
      JOIN users u ON u.id::text = a.target_id
     WHERE a.action = 'SCIM_USER_DELETE'
     GROUP BY a.tenant_id, a.target_id
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    GET DIAGNOSTICS n_records = ROW_COUNT;

    -- Every team, in one statement ordered by id, before any member or invitation
    -- write (team-key-rotation-lock.ts). SHARE does not conflict with SHARE:
    -- a rotation takes its lock first and fails while this block holds it.
    PERFORM 1 FROM teams ORDER BY id FOR SHARE;

    -- 2a. PENDING invitations issued by a user who departed at or after issue.
    UPDATE team_invitations ti
       SET status = 'EXPIRED', updated_at = clock_timestamp()
      FROM tenant_members tmb
     WHERE ti.status = 'PENDING'
       AND tmb.tenant_id = ti.tenant_id
       AND tmb.user_id = ti.invited_by_id
       AND tmb.deactivated_at IS NOT NULL
       AND tmb.deactivated_at >= ti.created_at;
    GET DIAGNOSTICS n_inviter = ROW_COUNT;

    -- 2b. PENDING invitations addressed to a user who departed at or after issue.
    UPDATE team_invitations ti
       SET status = 'EXPIRED', updated_at = clock_timestamp()
      FROM users u
      JOIN tenant_members tmb ON tmb.user_id = u.id
     WHERE ti.status = 'PENDING'
       AND lower(u.email) = lower(ti.email)
       AND tmb.tenant_id = ti.tenant_id
       AND tmb.deactivated_at IS NOT NULL
       AND tmb.deactivated_at >= ti.created_at;
    GET DIAGNOSTICS n_invitee = ROW_COUNT;

    -- 2c, second half: expire the invitations the departure records void.
    UPDATE team_invitations ti
       SET status = 'EXPIRED', updated_at = clock_timestamp()
      FROM users u
      JOIN tenant_member_departures d ON d.user_id = u.id
     WHERE ti.status = 'PENDING'
       AND lower(u.email) = lower(ti.email)
       AND d.tenant_id = ti.tenant_id
       AND d.departed_at >= ti.created_at;
    GET DIAGNOSTICS n_deleted_invitee = ROW_COUNT;

    -- 1. The candidates' memberships, ended as a departure ends them (marker
    --    set, stamped with the tenant row's value), and one audit_outbox row
    --    per membership with the payload buildOutboxPayload gives
    --    endTeamMemberships' call (src/lib/team/team-departure.ts) except the
    --    actor. These rows are also the evidence a later run excludes by.
    --    The metadata holds constants and a database timestamp only, so
    --    bypassing the app's metadata sanitiser is harmless. departedAt is
    --    rendered as JSON.stringify(Date) renders it (UTC, milliseconds).
    WITH ended AS (
      UPDATE team_members tm
         SET deactivated_at = tmb.deactivated_at,
             deactivated_by_tenant = true,
             updated_at = clock_timestamp()
        FROM tenant_members tmb
       WHERE tmb.tenant_id = tm.tenant_id
         AND tmb.user_id = tm.user_id
         AND tm.deactivated_at IS NULL
         AND tmb.deactivated_at IS NOT NULL
         AND tm.created_at < tmb.deactivated_at
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs a
            WHERE a.tenant_id = tm.tenant_id
              AND a.action = 'TEAM_MEMBER_TENANT_DEACTIVATE'
              AND a.target_id = tm.user_id::text)
         AND NOT EXISTS (
           SELECT 1 FROM audit_outbox o
            WHERE o.tenant_id = tm.tenant_id
              AND o.payload->>'action' = 'TEAM_MEMBER_TENANT_DEACTIVATE'
              AND o.payload->>'targetId' = tm.user_id::text)
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
                 'departedAt', to_char(e.departed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
               'ip', NULL,
               'userAgent', NULL)
        FROM ended e
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ended), (SELECT count(*) FROM enqueued)
      INTO n_memberships, n_outbox;

    SELECT count(*) INTO n_ownerless
      FROM teams t
     WHERE NOT EXISTS (
       SELECT 1 FROM team_members tm
        WHERE tm.team_id = t.id AND tm.role = 'OWNER' AND tm.deactivated_at IS NULL);

    RAISE NOTICE 'team-tenant-departure-rerun backfill: memberships=% outbox_rows=% invitations_inviter=% invitations_invitee=% departure_records=% invitations_deleted_invitee=% ownerless_teams=%',
      n_memberships, n_outbox, n_inviter, n_invitee, n_records, n_deleted_invitee, n_ownerless;
  END IF;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$backfill$;
-- END BACKFILL team-tenant-departure-rerun

-- BEGIN BACKFILL team-key-rotation-rekey-rerun
-- Steps 2-4 run on every role: each moves only rows in the pre-change state to
-- the state the app itself gives them (high-water only raised, an id for a v1+
-- entry the app would otherwise mint as pending re-key, a history id on an
-- identical wrap); on app-written rows they are no-ops. Step 1 (marker) does
-- not have that property: history restore writes marker 0 when the restored
-- ItemKey is not the live one, which on a never-rotated team looks exactly like
-- a pre-change row. So it runs only where the original could not have (a role
-- that cannot bypass RLS), and only on rows still at high-water 0 (a pre-change
-- row holds the default; a restore raises it to at least the restored version).
DO $backfill$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_can_bypass boolean;
  n_marker integer := 0;
  n_high_water integer;
  n_entry_ids integer;
  n_history_ids integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables',
    'teams,team_password_entries,team_password_entry_histories,attachments', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;

  -- Every team, in one statement ordered by id, before any entry write
  -- (team-key-rotation-lock.ts); also the rows step 1 reads.
  PERFORM 1 FROM teams ORDER BY id FOR SHARE;

  -- 1. Entries of a team still at its first key version (team key versions
  --    below 1 count as 1) hold an ItemKey created under the current team
  --    key. Every other entry is pending (the column default 0).
  IF NOT v_can_bypass THEN
    UPDATE team_password_entries e
       SET item_key_team_key_version = 1
      FROM teams t
     WHERE t.id = e.team_id
       AND t.team_key_version <= 1
       AND e.item_key_team_key_version = 0
       AND e.item_key_version_high_water = 0;
    GET DIAGNOSTICS n_marker = ROW_COUNT;
  END IF;

  -- 2. High-water: the largest itemKeyVersion the entry, its history rows and
  --    its attachments' CEK wraps (cek_key_version is NULL for mode 0) use.
  UPDATE team_password_entries e
     SET item_key_version_high_water = v.high_water
    FROM (
      SELECT e2.id,
             GREATEST(
               e2.item_key_version,
               COALESCE((SELECT max(h.item_key_version) FROM team_password_entry_histories h WHERE h.entry_id = e2.id), 0),
               COALESCE((SELECT max(a.cek_key_version) FROM attachments a WHERE a.team_password_entry_id = e2.id), 0)
             ) AS high_water
        FROM team_password_entries e2
    ) v
   WHERE v.id = e.id
     AND v.high_water > e.item_key_version_high_water;
  GET DIAGNOSTICS n_high_water = ROW_COUNT;

  -- 3. An id for every ItemKey an entry holds (v0 entries hold none).
  UPDATE team_password_entries
     SET item_key_id = gen_random_uuid()
   WHERE item_key_version >= 1
     AND item_key_id IS NULL;
  GET DIAGNOSTICS n_entry_ids = ROW_COUNT;

  -- 4. A history row carries the entry's id only when its whole wrap equals
  --    the entry's. Plain `=`: a NULL column never matches, so such a row
  --    keeps a NULL id (unknown ItemKey).
  UPDATE team_password_entry_histories h
     SET item_key_id = e.item_key_id
    FROM team_password_entries e
   WHERE e.id = h.entry_id
     AND e.item_key_id IS NOT NULL
     AND h.item_key_id IS NULL
     AND h.encrypted_item_key = e.encrypted_item_key
     AND h.item_key_iv = e.item_key_iv
     AND h.item_key_auth_tag = e.item_key_auth_tag
     AND h.team_key_version = e.team_key_version
     AND h.item_key_version = e.item_key_version;
  GET DIAGNOSTICS n_history_ids = ROW_COUNT;

  RAISE NOTICE 'team-key-rotation-rekey-rerun backfill: marker=% high_water=% entry_ids=% history_ids=%',
    n_marker, n_high_water, n_entry_ids, n_history_ids;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$backfill$;
-- END BACKFILL team-key-rotation-rekey-rerun

COMMIT;
