BEGIN;

-- leftover-team-actor-authority SEC-F1. share_creator_admitted (20261114000100)
-- compared the creator's tenant departure with the SHARE's created_at only, so a
-- share created AFTER the creator departed, by a leftover team_members row the
-- departure missed, was still served. It now also refuses when the creator
-- departed at or after their team membership began:
-- GREATEST(tenant_members.deactivated_at, tenant_member_departures.departed_at)
-- >= COALESCE(team_members.admitted_at, team_members.created_at)
-- (the actorDepartedSinceAdmission() definition; equality refuses). A creator
-- re-admitted after the departure, a never-departed creator and a guest creator
-- (NULL) are admitted. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.share_creator_admitted(p_share_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_admitted boolean;
BEGIN
  BEGIN
    PERFORM set_config('app.bypass_rls', 'on', true);
    PERFORM set_config('app.bypass_tables', 'password_shares,team_password_entries,team_members,team_policies,password_entries,tenant_members,tenant_member_departures', true);
    PERFORM set_config('app.bypass_purpose', 'share_admission', true);
    -- A team share: has a team entry, or is client-encrypted (version 0) — the
    -- latter keeps a share whose entry or team was deleted (FK set NULL) a team
    -- share, refused below. A personal entry share: an ENTRY_SHARE under the
    -- server key with no team entry. Anything else (Sends) is admitted.
    SELECT CASE
             WHEN s.team_password_entry_id IS NULL AND s.master_key_version <> 0 THEN
               s.share_type <> 'ENTRY_SHARE' OR EXISTS (
                 SELECT 1
                   FROM password_entries pe
                  WHERE pe.id = s.password_entry_id
                    AND pe.deleted_at IS NULL)
             ELSE EXISTS (
               SELECT 1
                 FROM team_password_entries e
                 JOIN team_members m ON m.team_id = e.team_id
                 LEFT JOIN tenant_members tm
                   ON tm.tenant_id = s.tenant_id AND tm.user_id = s.created_by_id
                 LEFT JOIN tenant_member_departures d
                   ON d.tenant_id = s.tenant_id AND d.user_id = s.created_by_id
                WHERE e.id = s.team_password_entry_id
                  AND e.deleted_at IS NULL
                  AND m.user_id = s.created_by_id
                  AND m.deactivated_at IS NULL
                  AND m.created_at <= s.created_at
                  -- The creator departed the tenant at or after creating the share
                  -- (NULL, i.e. never departed or a guest, admits).
                  AND (GREATEST(tm.deactivated_at, d.departed_at) >= s.created_at) IS NOT TRUE
                  -- ... or at or after their membership of this team began (a leftover row).
                  AND (GREATEST(tm.deactivated_at, d.departed_at) >= COALESCE(m.admitted_at, m.created_at)) IS NOT TRUE
                  -- No policy row means the defaults: sharing allowed, no password required.
                  AND NOT EXISTS (
                    SELECT 1
                      FROM team_policies p
                     WHERE p.team_id = e.team_id
                       AND (NOT p.allow_sharing
                            OR (p.require_share_password AND s.access_password_hash IS NULL))))
           END
      INTO v_admitted
      FROM password_shares s
     WHERE s.id = p_share_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  RETURN COALESCE(v_admitted, false);
END;
$$;

COMMIT;
