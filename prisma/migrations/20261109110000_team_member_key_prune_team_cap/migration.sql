-- #1009 code review round 2 (functionality N1). Redefines team_member_key_prune
-- (20261109100000) so it holds team locks only briefly and on few teams.
--
-- Why: the previous body locked up to p_batch teams (RETENTION_GC_BATCH_SIZE,
-- 1000 by default) while its pre-filter scan was still running, and held them
-- through the deciding statement, the audit enqueues and the commit. Every
-- team writer (entry create/update, restore, re-key, attachments, membership)
-- waits for that lock at most TEAM_KEY_LOCK_TIMEOUT_MS (3 s) and then fails.
--
-- Now three statements:
--   1. no lock: choose at most 25 candidate teams (an old version that no row
--      references at this snapshot; ORDER BY id) — the pre-filter's cost is
--      paid before any lock exists;
--   2. lock exactly those teams by primary key, `FOR NO KEY UPDATE ... SKIP
--      LOCKED` (cheap: at most 25 index lookups);
--   3. decide and delete for the locked teams on a new READ COMMITTED snapshot
--      (unchanged).
-- The locks are held from step 2 to the caller's commit: step 3 plus at most 25
-- audit rows. The team cap is a constant in the body, not a parameter: a new
-- parameter would change the signature (a new function, grants, the RDS role
-- bootstrap and the grant manifest), and nothing needs to tune it. 25 keeps a
-- call's lock footprint small while a tick still clears 25 teams; teams beyond
-- them are reached on later ticks, because a team leaves the candidate set once
-- its unreferenced versions are gone. p_batch still bounds the deleted pairs.
--
-- The concurrency argument is unchanged (20261109100000): every copier of a
-- non-current version holds `teams ... FOR SHARE` for its whole transaction,
-- the lock in step 2 conflicts with it and skips, and step 3 runs after the
-- locks are held. Step 1 only chooses what to lock.
--
-- CREATE OR REPLACE keeps the owner and the ACL; they are re-asserted below.

BEGIN;

CREATE OR REPLACE FUNCTION public.team_member_key_prune(p_batch integer)
 RETURNS TABLE(pruned_tenant_id uuid, pruned_team_id uuid, pruned_key_version integer, pruned_user_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cands uuid[];
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

  -- Step 1, no lock taken: at most 25 teams with an old version no row
  -- references at this snapshot.
  SELECT array_agg(c.id) INTO v_cands
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
       LIMIT 25
    ) c;

  -- Step 2: lock those teams by primary key; a team a writer holds is skipped.
  SELECT array_agg(s.id) INTO v_teams
    FROM (
      SELECT t.id
        FROM teams t
       WHERE t.id = ANY (v_cands)
       ORDER BY t.id
       FOR NO KEY UPDATE OF t SKIP LOCKED
    ) s;

  -- Step 3: a new snapshot, taken with the locks held; decide and delete.
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
