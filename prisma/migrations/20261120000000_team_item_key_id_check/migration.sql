-- #1011: the ItemKey identity constraints deferred by
-- 20261104000000_team_key_rotation_rekey (D41 in
-- docs/archive/review/team-key-rotation-rekey-deviation.md), after a repair of
-- what the previous release left during the 0.5.0 rollout
-- (docs/archive/review/team-item-key-id-check-plan.md D-a, D-b).
--
--  * team_password_entries: (item_key_version = 0) = (item_key_id IS NULL).
--  * team_password_entry_histories: item_key_version <> 0 OR item_key_id IS NULL.
--    A v1+ history row keeps a NULL id when its ItemKey's identity is unknown.
--
-- Deploy runs this before the services roll, so the release still serving is
-- 0.5.0, which writes nothing either CHECK refuses. A deploy that skips 0.5.0
-- is not supported (docs/operations/deployment.md).
--
-- Both CHECKs are added NOT VALID here, so they bind every write from this
-- commit on without a scan under the table lock; 20261120000100 validates them.
--
-- Wrapped in BEGIN/COMMIT: a DO block and two ALTERs
-- (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

-- Repair. Every repaired entry gets marker 0, so it is pending re-key: the
-- pass replaces its ItemKey and settles whatever the repair could not prove.
-- No wrap or blob is touched, so every row stays decryptable.
--
--  1. v0 entry with an id (0.4.77 history restore of a v0 row onto an entry
--     that had one): id NULL. A v0 entry holds no ItemKey.
--  2. v1+ entry with no id (0.4.77 create, upgrade or restore): the id of its
--     history rows whose wrap equals the entry's, when they carry exactly one;
--     equal wraps are the same ItemKey. Otherwise
--  3. a minted id.
--  4. Marker 0, id kept, for an entry whose rows prove a 0.4.77 write left
--     its ItemKey's creation version wrong:
--     a. a marker above its wrap's (normalised) team key version. 0.5.0 sets
--        the marker to the wrap's version or keeps it with an ItemKey whose
--        wraps are all at or after it; 0.4.77 restored an older wrap and kept
--        the marker.
--     b. v1+ with an id and a marker above 0, sharing its wrap with a history
--        row under another id. Two labels on one ItemKey are legitimate in
--        0.5.0 (its restore mints an id for each restore of a history row of
--        unknown identity), so no label is moved; but that restore writes
--        marker 0, and no 0.5.0 writer that sets a marker above 0 keeps the
--        wrap. Only a 0.4.77 restore of a row that had an id leaves this.
--     c. v1+ with an id and a marker above 0, whose id a history row or an
--        attachment's CEK carries at another itemKeyVersion. In 0.5.0 an id
--        names one version (every new ItemKey gets a new id); 0.4.77 changed
--        the version (a restore, or an upgrade of a v0 entry a restore had
--        left an id on) and kept the id.
--     The entry may then hold an ItemKey from before a rotation. A restore of
--     another key at the same version and team key version leaves no
--     evidence, and stays as it is.
--  5. v0 history row with an id (0.5.0 snapshot of a case-1 entry): id NULL.
--  6. History rows of the entries 2-3 gave an id, whose wrap equals the
--     entry's and that have no id: the entry's id. Only those entries, for the
--     reason in 4.
--  7. High-water raised to the largest itemKeyVersion the entry, its history
--     and its attachments use (0.4.77 never raised it).
-- Wrap equality is 20261104000000 step 4's: all five columns, plain `=`, so a
-- NULL column never matches.
--
-- Locks: both tables ACCESS EXCLUSIVE first, in the app's order (entry, then
-- its history), so neither ADD CONSTRAINT below is a lock upgrade. Every
-- writer of these columns takes an entries lock first, and the block holds
-- no lock before this one.
--
-- Same on every role, and idempotent: each step moves only rows in a shape no
-- 0.5.0 writer produces. Every table is under FORCE RLS and the RDS migrate
-- role is NOSUPERUSER NOBYPASSRLS, so the block grants itself exactly these
-- tables, transaction-locally, and restores the previous settings after
-- (20261116200000 is the precedent). The NOTICE is seen through psql, or in
-- the server log where log_min_messages is notice or lower; `prisma migrate
-- deploy` does not print it.
-- BEGIN BACKFILL team-item-key-id-check
DO $backfill$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_adopted uuid[];
  v_minted uuid[];
  n_v0_ids integer;
  n_stale_pending integer;
  n_history_v0_ids integer;
  n_history_ids integer;
  n_high_water integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables',
    'team_password_entries,team_password_entry_histories,attachments', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  LOCK TABLE team_password_entries, team_password_entry_histories IN ACCESS EXCLUSIVE MODE;

  -- 1.
  UPDATE team_password_entries
     SET item_key_id = NULL,
         item_key_team_key_version = 0
   WHERE item_key_version = 0
     AND item_key_id IS NOT NULL;
  GET DIAGNOSTICS n_v0_ids = ROW_COUNT;

  -- 2.
  WITH proven AS (
    SELECT e.id, (array_agg(DISTINCT h.item_key_id))[1] AS item_key_id
      FROM team_password_entries e
      JOIN team_password_entry_histories h
        ON h.entry_id = e.id
       AND h.item_key_id IS NOT NULL
       AND h.encrypted_item_key = e.encrypted_item_key
       AND h.item_key_iv = e.item_key_iv
       AND h.item_key_auth_tag = e.item_key_auth_tag
       AND h.team_key_version = e.team_key_version
       AND h.item_key_version = e.item_key_version
     WHERE e.item_key_version >= 1
       AND e.item_key_id IS NULL
     GROUP BY e.id
    HAVING count(DISTINCT h.item_key_id) = 1
  ), adopted AS (
    UPDATE team_password_entries e
       SET item_key_id = p.item_key_id,
           item_key_team_key_version = 0
      FROM proven p
     WHERE e.id = p.id
    RETURNING e.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_adopted FROM adopted;

  -- 3.
  WITH minted AS (
    UPDATE team_password_entries
       SET item_key_id = gen_random_uuid(),
           item_key_team_key_version = 0
     WHERE item_key_version >= 1
       AND item_key_id IS NULL
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_minted FROM minted;

  -- 4.
  UPDATE team_password_entries e
     SET item_key_team_key_version = 0
   WHERE e.item_key_team_key_version > GREATEST(e.team_key_version, 1)
      OR (e.item_key_version >= 1
          AND e.item_key_id IS NOT NULL
          AND e.item_key_team_key_version > 0
          AND (EXISTS (
                 SELECT 1 FROM team_password_entry_histories h
                  WHERE h.entry_id = e.id
                    AND h.item_key_id IS NOT NULL
                    AND h.item_key_id <> e.item_key_id
                    AND h.encrypted_item_key = e.encrypted_item_key
                    AND h.item_key_iv = e.item_key_iv
                    AND h.item_key_auth_tag = e.item_key_auth_tag
                    AND h.team_key_version = e.team_key_version
                    AND h.item_key_version = e.item_key_version)
               OR EXISTS (
                 SELECT 1 FROM team_password_entry_histories h
                  WHERE h.entry_id = e.id
                    AND h.item_key_id = e.item_key_id
                    AND h.item_key_version <> e.item_key_version)
               OR EXISTS (
                 SELECT 1 FROM attachments a
                  WHERE a.team_password_entry_id = e.id
                    AND a.cek_item_key_id = e.item_key_id
                    AND a.cek_key_version <> e.item_key_version)));
  GET DIAGNOSTICS n_stale_pending = ROW_COUNT;

  -- 5.
  UPDATE team_password_entry_histories
     SET item_key_id = NULL
   WHERE item_key_version = 0
     AND item_key_id IS NOT NULL;
  GET DIAGNOSTICS n_history_v0_ids = ROW_COUNT;

  -- 6.
  UPDATE team_password_entry_histories h
     SET item_key_id = e.item_key_id
    FROM team_password_entries e
   WHERE e.id = ANY (v_adopted || v_minted)
     AND h.entry_id = e.id
     AND h.item_key_id IS NULL
     AND h.encrypted_item_key = e.encrypted_item_key
     AND h.item_key_iv = e.item_key_iv
     AND h.item_key_auth_tag = e.item_key_auth_tag
     AND h.team_key_version = e.team_key_version
     AND h.item_key_version = e.item_key_version;
  GET DIAGNOSTICS n_history_ids = ROW_COUNT;

  -- 7.
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

  RAISE NOTICE 'team-item-key-id-check backfill: v0_ids_cleared=% ids_adopted=% ids_minted=% stale_pending=% history_v0_ids_cleared=% history_ids=% high_water=%',
    n_v0_ids, cardinality(v_adopted), cardinality(v_minted), n_stale_pending, n_history_v0_ids, n_history_ids, n_high_water;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$backfill$;
-- END BACKFILL team-item-key-id-check

ALTER TABLE "team_password_entries"
  ADD CONSTRAINT "team_password_entries_item_key_id_iff_item_key"
  CHECK (("item_key_version" = 0) = ("item_key_id" IS NULL)) NOT VALID;

ALTER TABLE "team_password_entry_histories"
  ADD CONSTRAINT "team_password_entry_histories_v0_no_item_key_id"
  CHECK ("item_key_version" <> 0 OR "item_key_id" IS NULL) NOT VALID;

COMMIT;
