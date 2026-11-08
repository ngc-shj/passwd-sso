-- Entry key identity for the team re-key pass
-- (docs/archive/review/team-key-rotation-rekey-plan.md C1).
--
--  * team_password_entries.item_key_team_key_version is the team key version
--    at which the entry's current ItemKey was created; the entry awaits re-key
--    while it is below teams.team_key_version. DEFAULT 0 fails safe: a writer
--    that misses the column leaves the entry pending.
--  * team_password_entries.item_key_version_high_water is the highest
--    itemKeyVersion the entry, its history or its attachments ever used; a new
--    ItemKey takes high_water + 1, so a version number is never reused.
--  * item_key_id identifies an ItemKey across rotation's re-wrap: on entries,
--    copied into history rows, and on team mode-2 attachments as
--    cek_item_key_id.
--
-- Wrapped in BEGIN/COMMIT because this migration has more than one DDL
-- statement (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

ALTER TABLE "team_password_entries" ADD COLUMN "item_key_team_key_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "team_password_entries" ADD COLUMN "item_key_version_high_water" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "team_password_entries" ADD COLUMN "item_key_id" UUID;
ALTER TABLE "team_password_entry_histories" ADD COLUMN "item_key_id" UUID;
ALTER TABLE "attachments" ADD COLUMN "cek_item_key_id" UUID;

-- BEGIN BACKFILL team-key-rotation-rekey
-- Idempotent: each UPDATE only moves rows still at the pre-backfill value.
DO $backfill$
DECLARE
  n_marker integer;
  n_high_water integer;
  n_entry_ids integer;
  n_history_ids integer;
BEGIN
  -- 1. Entries of a team still at its first key version (team key versions
  --    below 1 count as 1) hold an ItemKey created under the current team
  --    key. Every other entry is pending (the column default 0).
  UPDATE team_password_entries e
     SET item_key_team_key_version = 1
    FROM teams t
   WHERE t.id = e.team_id
     AND t.team_key_version <= 1
     AND e.item_key_team_key_version = 0;
  GET DIAGNOSTICS n_marker = ROW_COUNT;

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

  RAISE NOTICE 'team-key-rotation-rekey backfill: marker=% high_water=% entry_ids=% history_ids=%',
    n_marker, n_high_water, n_entry_ids, n_history_ids;
END
$backfill$;

-- No CHECK ((item_key_version = 0) = (item_key_id IS NULL)) in this release:
-- deploy runs this migration before the services roll, and an instance still
-- on the previous release creates or upgrades a v1 entry without an id. The
-- application treats a v1+ entry with a NULL id as pending re-key, and the
-- pass mints its id. The CHECK ships in the next release, after a backfill of
-- such rows (follow-up).
-- END BACKFILL team-key-rotation-rekey

COMMIT;
