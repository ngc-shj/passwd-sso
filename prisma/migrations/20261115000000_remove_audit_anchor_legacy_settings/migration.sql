-- #949. Removes the two system_settings rows the audit-anchor publisher decided
-- from before it read published state from its primary destination:
--
--   audit_anchor_last_published_boundary  the "this boundary is published" marker
--   audit_anchor_previous_manifest        the pointer the next manifest chained to
--
-- No code reads or writes them any more, and a row nothing reads is still a row
-- an operator may take for state. The publisher's other rows stay:
-- audit_anchor_deployment_id and audit_anchor_upload_attempts.
--
-- The release before this one still decides from them. Without the marker it
-- falls back to last_published_at; without the pointer the next manifest it
-- publishes names no previous one. deploy.sh migrates before it replaces the
-- publisher, so an upgrade must not span the publish time
-- (docs/operations/deployment.md, "Upgrade order").
--
-- system_settings is under FORCE RLS and the RDS migrate role is NOSUPERUSER
-- NOBYPASSRLS, so without a bypass this DELETE sees no rows there (while a
-- local superuser sees them all). The block grants itself exactly the one
-- table, transaction-locally, and restores the previous settings after
-- (20261109162613 is the precedent). app.tenant_id is set to the nil UUID as
-- there, though this table's policy has no tenant arm.
-- BEGIN BACKFILL audit-anchor-legacy-settings
DO $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_deleted integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables', 'system_settings', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  DELETE FROM system_settings
   WHERE key IN ('audit_anchor_previous_manifest', 'audit_anchor_last_published_boundary');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'audit-anchor-legacy-settings: % row(s) removed', v_deleted;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$$;
-- END BACKFILL audit-anchor-legacy-settings
