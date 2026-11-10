BEGIN;

-- #1016. Who minted a service-account token, so a tenant admin containing a
-- compromised member can find and revoke the tokens that member minted — on any
-- service account of the tenant, not only the ones they created. Set by both
-- mint paths: POST .../service-accounts/[id]/tokens (the admin) and JIT
-- approval (the approver). ON DELETE SET NULL: a token outlives its minter's
-- user row, as the token itself is the tenant's credential.

ALTER TABLE "service_account_tokens" ADD COLUMN "created_by_id" UUID;

CREATE INDEX "service_account_tokens_created_by_id_idx" ON "service_account_tokens"("created_by_id");

ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: a JIT token's minter is the approver of the access request that
-- granted it. Tokens minted directly before this migration have no record of
-- their minter here and stay NULL (their SERVICE_ACCOUNT_TOKEN_CREATE audit rows
-- name it).
--
-- Both tables are under FORCE RLS and the RDS migrate role is NOSUPERUSER
-- NOBYPASSRLS, so without a bypass this UPDATE sees no rows there (while a
-- local superuser sees them all). The block grants itself exactly the two
-- tables, transaction-locally, and restores the previous settings after, as
-- share_creator_admitted (20261102000000) does. app.tenant_id is set to the nil
-- UUID so the policies' tenant arm casts cleanly.
-- BEGIN BACKFILL service-account-token-creator
DO $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_updated integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables', 'service_account_tokens,access_requests', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  UPDATE service_account_tokens t
     SET created_by_id = ar.approved_by_id
    FROM access_requests ar
   WHERE ar.granted_token_id = t.id
     AND ar.tenant_id = t.tenant_id
     AND ar.approved_by_id IS NOT NULL
     AND t.created_by_id IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'service-account-token-creator backfill: % JIT token(s) attributed to their approver', v_updated;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$$;
-- END BACKFILL service-account-token-creator

COMMIT;
