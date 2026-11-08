-- #1009 code review round 1 (SS1, FF1). Redefines team_member_key_prune
-- (20261108120100) so the reference decision is made under a team lock.
--
-- Why: a single statement reads one snapshot, but that is not enough. A
-- history restore holds `teams FOR SHARE`, reads history row h (version k)
-- unlocked, and writes the entry at k; a third party (the retention GC history
-- age sweep) can delete h and commit in between. A prune whose snapshot sees
-- neither h (deleted) nor the entry at k (not yet committed) deletes k, and
-- the restore then commits an entry sealed under a key nobody holds.
--
-- Concurrency argument. Every transaction that copies a non-current version
-- into a row (history restore, the full-update PUT's history snapshot, the
-- per-entry re-key) holds `teams ... FOR SHARE` from before it reads the copy
-- source until it commits; rotation holds `teams ... FOR NO KEY UPDATE`
-- (team-key-rotation-lock.ts). The prune:
--   1. locks the teams it will consider, `FOR NO KEY UPDATE ... SKIP LOCKED`
--      (conflicts with FOR SHARE and with another FOR NO KEY UPDATE): a team
--      any such writer holds is skipped, never waited on, and a writer that
--      starts later waits for the prune's transaction to end;
--   2. then, in a new statement (READ COMMITTED: a new snapshot, taken after
--      the locks are held), reads the references and deletes, restricted to
--      the locked teams.
-- So every copier of a locked team either committed before step 1 (and step
-- 2 sees its row) or has not started. A third-party deleter of a copy source
-- is covered because the copier still holds its team lock: the team is
-- skipped. The isolation check makes the argument's premise explicit — under
-- REPEATABLE READ step 2 would reuse the transaction's first snapshot.
--
-- Step 1 locks at most p_batch teams, and only teams with at least one old
-- version that no row references at step 1's (pre-lock) snapshot: without
-- that filter, more than p_batch teams whose old versions are all still
-- referenced would fill every call and the teams after them would never be
-- reached. The filter only chooses what to lock; step 2 decides, again, on
-- its own snapshot.
--
-- Cost (FF1): step 2 evaluates the three reference checks once per distinct
-- (team, version) pair of the locked teams (`pairs`), not once per member row,
-- and stops after p_batch unreferenced pairs. No index serves the version
-- predicates themselves; each check is an index lookup on the team or entry
-- and a scan of that team's rows.
--
-- The decision rule is unchanged: a (team_id, key_version) pair is deleted,
-- for every member, only when it is below the team's current version and no
-- team_password_entries row of the team, no team_password_entry_histories row
-- of an entry of the team, and no mode-0 attachments row of an entry of the
-- team names it; a stored version below 1 counts as 1 (normalizeTeamKeyVersion);
-- the re-key marker (item_key_team_key_version) is never part of it. p_batch
-- bounds the pairs deleted.
--
-- CREATE OR REPLACE keeps the owner and the ACL (EXECUTE for
-- passwd_retention_gc_worker only, none for PUBLIC); they are re-asserted
-- below anyway so this migration alone states them.

BEGIN;

CREATE OR REPLACE FUNCTION public.team_member_key_prune(p_batch integer)
 RETURNS TABLE(pruned_tenant_id uuid, pruned_team_id uuid, pruned_key_version integer, pruned_user_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_teams uuid[];
BEGIN
  IF NOT (SELECT public.rls_bypass_admits('team_member_keys')) THEN
    RAISE EXCEPTION 'TEAM_KEY_PRUNE_REQUIRES_BYPASS: team_member_key_prune must run under an RLS bypass that grants team_member_keys'
      USING ERRCODE = '42501';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'TEAM_KEY_PRUNE_BATCH: p_batch must be a positive integer'
      USING ERRCODE = '22023';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TEAM_KEY_PRUNE_ISOLATION: team_member_key_prune must run under READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;

  -- Step 1: lock the candidate teams; a team a writer holds is skipped.
  SELECT array_agg(s.id) INTO v_teams
    FROM (
      SELECT t.id
        FROM teams t
       WHERE EXISTS (
         SELECT 1
           FROM (SELECT DISTINCT ck.key_version
                   FROM team_member_keys ck
                  WHERE ck.team_id = t.id
                    AND ck.key_version < t.team_key_version) cv
          WHERE NOT EXISTS (
                  SELECT 1 FROM team_password_entries ce
                   WHERE ce.team_id = t.id
                     AND (ce.team_key_version = cv.key_version
                          OR (cv.key_version = 1 AND COALESCE(ce.team_key_version, 0) < 1)))
            AND NOT EXISTS (
                  SELECT 1 FROM team_password_entry_histories ch
                    JOIN team_password_entries che ON che.id = ch.entry_id
                   WHERE che.team_id = t.id
                     AND (ch.team_key_version = cv.key_version
                          OR (cv.key_version = 1 AND COALESCE(ch.team_key_version, 0) < 1)))
            AND NOT EXISTS (
                  SELECT 1 FROM attachments ca
                    JOIN team_password_entries cae ON cae.id = ca.team_password_entry_id
                   WHERE cae.team_id = t.id
                     AND ca.encryption_mode = 0
                     AND (ca.key_version = cv.key_version
                          OR (cv.key_version = 1 AND COALESCE(ca.key_version, 0) < 1)))
       )
       ORDER BY t.id
       LIMIT p_batch
       FOR NO KEY UPDATE OF t SKIP LOCKED
    ) s;

  -- Step 2: a new snapshot, taken with the locks held; decide and delete.
  RETURN QUERY
  WITH pairs AS MATERIALIZED (
    SELECT DISTINCT tmk.team_id, tmk.key_version
      FROM team_member_keys tmk
      JOIN teams t ON t.id = tmk.team_id
     WHERE tmk.team_id = ANY (v_teams)
       AND tmk.key_version < t.team_key_version
  ),
  picked AS MATERIALIZED (
    SELECT p.team_id, p.key_version
      FROM pairs p
     WHERE NOT EXISTS (
         SELECT 1 FROM team_password_entries e
          WHERE e.team_id = p.team_id
            AND (e.team_key_version = p.key_version
                 OR (p.key_version = 1 AND COALESCE(e.team_key_version, 0) < 1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM team_password_entry_histories h
           JOIN team_password_entries he ON he.id = h.entry_id
          WHERE he.team_id = p.team_id
            AND (h.team_key_version = p.key_version
                 OR (p.key_version = 1 AND COALESCE(h.team_key_version, 0) < 1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM attachments a
           JOIN team_password_entries ae ON ae.id = a.team_password_entry_id
          WHERE ae.team_id = p.team_id
            AND a.encryption_mode = 0
            AND (a.key_version = p.key_version
                 OR (p.key_version = 1 AND COALESCE(a.key_version, 0) < 1))
       )
     ORDER BY p.team_id, p.key_version
     LIMIT p_batch
  ),
  del AS (
    DELETE FROM team_member_keys d
     USING picked k
     WHERE d.team_id = k.team_id
       AND d.key_version = k.key_version
    RETURNING d.tenant_id, d.team_id, d.key_version, d.user_id
  )
  SELECT del.tenant_id, del.team_id, del.key_version, array_agg(del.user_id ORDER BY del.user_id)
    FROM del
   GROUP BY del.tenant_id, del.team_id, del.key_version;
END;
$function$;

REVOKE ALL ON FUNCTION public.team_member_key_prune(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT EXECUTE ON FUNCTION public.team_member_key_prune(integer) TO passwd_retention_gc_worker;
  END IF;
END
$$;

COMMIT;
