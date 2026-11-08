-- #1009. Prune a team's TeamMemberKey versions that no row of the team can
-- still need. The retention GC worker calls this; it holds EXECUTE on the
-- function and no table grant on any table the body touches.
--
-- A (team_id, key_version) pair is deleted, for every member, only when:
--   - it is below the team's current version (never the current one);
--   - no team_password_entries row of the team names it;
--   - no team_password_entry_histories row of an entry of the team names it;
--   - no mode-0 attachments row of an entry of the team names it.
-- A stored version below 1 counts as 1, as the reader normalises it
-- (normalizeTeamKeyVersion), spelled `v = k OR (k = 1 AND COALESCE(v, 0) < 1)`
-- so the equality arm stays index-friendly. The re-key marker
-- (item_key_team_key_version) is never part of the decision.
--
-- One statement: the checks and the DELETE read one snapshot, so a reference
-- a committed transaction moved between tables is seen on one side. p_batch
-- bounds the (team_id, key_version) pairs, not the rows.
--
-- The caller's RLS bypass is checked first, as audit_log_purge does
-- (20261021000000): bypass off -> refused (42501); bypass on with a grant that
-- does not name team_member_keys -> reported now (report mode) and refused once
-- rls_bypass_enforced() is flipped (#921).

BEGIN;

CREATE OR REPLACE FUNCTION public.team_member_key_prune(p_batch integer)
 RETURNS TABLE(pruned_tenant_id uuid, pruned_team_id uuid, pruned_key_version integer, pruned_user_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT (SELECT public.rls_bypass_admits('team_member_keys')) THEN
    RAISE EXCEPTION 'TEAM_KEY_PRUNE_REQUIRES_BYPASS: team_member_key_prune must run under an RLS bypass that grants team_member_keys'
      USING ERRCODE = '42501';
  END IF;
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'TEAM_KEY_PRUNE_BATCH: p_batch must be a positive integer'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT DISTINCT tmk.team_id, tmk.key_version
      FROM team_member_keys tmk
      JOIN teams t ON t.id = tmk.team_id
     WHERE tmk.key_version < t.team_key_version
       AND NOT EXISTS (
         SELECT 1 FROM team_password_entries e
          WHERE e.team_id = tmk.team_id
            AND (e.team_key_version = tmk.key_version
                 OR (tmk.key_version = 1 AND COALESCE(e.team_key_version, 0) < 1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM team_password_entry_histories h
           JOIN team_password_entries he ON he.id = h.entry_id
          WHERE he.team_id = tmk.team_id
            AND (h.team_key_version = tmk.key_version
                 OR (tmk.key_version = 1 AND COALESCE(h.team_key_version, 0) < 1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM attachments a
           JOIN team_password_entries ae ON ae.id = a.team_password_entry_id
          WHERE ae.team_id = tmk.team_id
            AND a.encryption_mode = 0
            AND (a.key_version = tmk.key_version
                 OR (tmk.key_version = 1 AND COALESCE(a.key_version, 0) < 1))
       )
     ORDER BY tmk.team_id, tmk.key_version
     LIMIT p_batch
  ),
  del AS (
    DELETE FROM team_member_keys d
     USING picked p
     WHERE d.team_id = p.team_id
       AND d.key_version = p.key_version
    RETURNING d.tenant_id, d.team_id, d.key_version, d.user_id
  )
  SELECT del.tenant_id, del.team_id, del.key_version, array_agg(del.user_id ORDER BY del.user_id)
    FROM del
   GROUP BY del.tenant_id, del.team_id, del.key_version;
END;
$function$;

-- PUBLIC holds EXECUTE on a new function by default unless the creating role's
-- default privileges removed it (20260725140000); revoke it explicitly so the
-- grant below is the only one either way.
REVOKE ALL ON FUNCTION public.team_member_key_prune(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_retention_gc_worker') THEN
    GRANT EXECUTE ON FUNCTION public.team_member_key_prune(integer) TO passwd_retention_gc_worker;
  END IF;
END
$$;

COMMIT;
