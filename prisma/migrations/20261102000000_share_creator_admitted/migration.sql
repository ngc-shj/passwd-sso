BEGIN;

-- #990. Whether a share link may still be served: a team-entry share only while
-- its creator holds the membership of the entry's team they held when they
-- created it, and the entry is not trashed or gone. The serve paths call this
-- beside their revoked check and inside their view-count UPDATEs, so it is the
-- single spelling of the rule (docs/archive/review/departed-member-share-links-plan.md C1).
--
-- SECURITY INVOKER with a call-scoped bypass. The serve paths run under bypass
-- grants that list only password_shares / share_access_logs, and the list routes
-- under a tenant context; under FORCE RLS a table-owner function is no escape on
-- RDS (the master is NOSUPERUSER NOBYPASSRLS). So the body grants itself exactly
-- the three tables it reads, for the duration of the call:
--   * the settings are saved, set inside the inner block (an error rolls them
--     back with the subtransaction), and restored after it on the single exit;
--   * a function-level `SET app.*` clause is not used: a NOSUPERUSER role cannot
--     create a routine that sets a placeholder setting, so the RDS migration
--     would fail;
--   * a never-set setting reads back as '' afterwards, which every reader treats
--     as unset.
-- Pattern of tenant_claim_events_purge_for_tenant (20260731100000).
CREATE FUNCTION public.share_creator_admitted(p_share_id uuid)
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
    PERFORM set_config('app.bypass_tables', 'password_shares,team_password_entries,team_members', true);
    PERFORM set_config('app.bypass_purpose', 'share_admission', true);
    -- A team share: has a team entry, or is client-encrypted (version 0) — the
    -- latter keeps a share whose entry or team was deleted (FK set NULL) a team
    -- share, refused below. Anything else (personal shares, Sends) is admitted.
    SELECT CASE
             WHEN s.team_password_entry_id IS NULL AND s.master_key_version <> 0 THEN true
             ELSE EXISTS (
               SELECT 1
                 FROM team_password_entries e
                 JOIN team_members m ON m.team_id = e.team_id
                WHERE e.id = s.team_password_entry_id
                  AND e.deleted_at IS NULL
                  AND m.user_id = s.created_by_id
                  AND m.deactivated_at IS NULL
                  AND m.created_at <= s.created_at)
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

REVOKE ALL ON FUNCTION public.share_creator_admitted(uuid) FROM PUBLIC;

-- Roles created after this migration (ci-integration bootstrap,
-- bootstrap-rds-roles.mjs ROUTINE_EXECUTE) grant it themselves.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT EXECUTE ON FUNCTION public.share_creator_admitted(uuid) TO passwd_app;
  END IF;
END
$$;

COMMIT;
