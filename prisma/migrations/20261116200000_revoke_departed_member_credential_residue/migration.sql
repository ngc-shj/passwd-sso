-- session-revocation-failure-surfaces C9 (code review round 2, F5/S3). Before
-- this release a directory-sync departure revoked nothing, and a SCIM or team
-- departure whose revocation failed after its commit only logged it. Either
-- left live credentials filed under a tenant the user had left, and any later
-- admission revives them: a SCIM POST or directory-sync create of the existing
-- user, an SSO sign-in's membership upsert, or an active membership in another
-- tenant (the proxy session gate checks "active anywhere", not "active here").
-- From this release on every membership end revokes in its own transaction
-- (check-team-rotation-input-lock.mjs rule 9), and this block removes the
-- residue that exists when it commits.
--
-- It does not stop residue from growing back during the rollout: this block
-- commits before the old release's instances stop serving, and those can still
-- leave residue behind. That residue is made unusable elsewhere: a session
-- is refused unless its tenant is one where its user is an active
-- member (the auth adapter's getSessionAndUser binding), a reactivation
-- revokes in the returning tenant (returnToTenant), and tokens are already
-- checked against the membership in their own tenant. One path remains: an
-- old-release SCIM DELETE whose revocation fails during the rollout, followed
-- by a later re-creation of that membership in the same tenant. It is
-- recorded, with its worst case, likelihood and cost, as D12 in
-- docs/archive/review/session-revocation-failure-surfaces-deviation.md.
--
-- Residue: a row of one of the ten models revokeUsersAuthArtifactsInTx revokes
-- (src/lib/auth/session/user-session-invalidation.ts) whose (user, tenant_id)
-- has no tenant_members row with deactivated_at IS NULL. Every mint stamps the
-- tenant of the user's active membership, and a user has at most one
-- (tenant_members_one_active_per_user), so no credential that can still be
-- used matches. Same semantics as the helper: sessions are deleted, tokens
-- and delegation sessions get revoked_at, operator tokens are matched by
-- subject_user_id, single-use codes get used_at. A row with a NULL user
-- (an MCP grant held by a service account or a client) is not a user's and is
-- not touched.
--
-- The credential lock (user-auth-serialization.ts, key 'user-auth:<id>') of
-- every user holding unexpired residue is taken first, in the app's order: a
-- concurrent refresh or code exchange of a residue row either committed
-- before (and its new row is revoked below) or waits and finds its proof
-- gone. Expired rows cannot be a mint's proof, so they need no lock.
--
-- That is one advisory lock per residue user, all held by this one
-- transaction. The shared lock table holds max_locks_per_transaction *
-- (max_connections + max_prepared_transactions) entries, and running out
-- aborts the block (it rolls back whole). The block NOTICEs the user count
-- before it takes the locks; if that count is near the bound, raise
-- max_locks_per_transaction and run the migration again.
--
-- Session cache: a deleted session's cached entry is either never there (the
-- auth gate does not cache a user active nowhere) or expires within
-- SESSION_CACHE_TTL_MS (30 s); no tombstone is written.
--
-- Idempotent: a second run finds nothing to change. A single DO statement, so
-- it commits or rolls back whole. Every table is under FORCE RLS and the RDS
-- migrate role is NOSUPERUSER NOBYPASSRLS, so the block grants itself exactly
-- these tables, transaction-locally, and restores the previous settings after
-- (20261115000000 is the precedent).
-- BEGIN BACKFILL departed-member-credential-residue
DO $$
DECLARE
  v_prev_rls text := current_setting('app.bypass_rls', true);
  v_prev_tables text := current_setting('app.bypass_tables', true);
  v_prev_purpose text := current_setting('app.bypass_purpose', true);
  v_prev_tenant text := current_setting('app.tenant_id', true);
  v_now timestamptz := now();
  v_users uuid[];
  n_sessions integer;
  n_extension_tokens integer;
  n_api_keys integer;
  n_mcp_access_tokens integer;
  n_mcp_refresh_tokens integer;
  n_delegation_sessions integer;
  n_operator_tokens integer;
  n_extension_bridge_codes integer;
  n_mobile_bridge_codes integer;
  n_mcp_authorization_codes integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('app.bypass_tables',
    'tenant_members,sessions,extension_tokens,api_keys,mcp_access_tokens,mcp_refresh_tokens,delegation_sessions,operator_tokens,extension_bridge_codes,mobile_bridge_codes,mcp_authorization_codes', true);
  PERFORM set_config('app.bypass_purpose', 'system_maintenance', true);
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

  SELECT COALESCE(array_agg(DISTINCT r.user_id), '{}')
    INTO v_users
    FROM (
      SELECT user_id, tenant_id FROM sessions WHERE expires > v_now
      UNION SELECT user_id, tenant_id FROM extension_tokens WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM api_keys WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM mcp_access_tokens WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM mcp_refresh_tokens WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM delegation_sessions WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT subject_user_id, tenant_id FROM operator_tokens WHERE revoked_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM extension_bridge_codes WHERE used_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM mobile_bridge_codes WHERE used_at IS NULL AND expires_at > v_now
      UNION SELECT user_id, tenant_id FROM mcp_authorization_codes WHERE used_at IS NULL AND expires_at > v_now
    ) r
   WHERE r.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = r.tenant_id AND tm.user_id = r.user_id AND tm.deactivated_at IS NULL);

  RAISE NOTICE 'departed-member-credential-residue-locks: users=%', cardinality(v_users);

  -- lockUsersAuthArtifacts' statement: one lock per user, in byte order of the key.
  PERFORM pg_advisory_xact_lock(hashtext(k))
    FROM (
      SELECT k FROM (SELECT 'user-auth:' || u::text AS k FROM unnest(v_users) AS u) AS keys
       ORDER BY k COLLATE "C"
    ) ordered;

  DELETE FROM sessions s
   WHERE NOT EXISTS (
     SELECT 1 FROM tenant_members tm
      WHERE tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  UPDATE extension_tokens t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_extension_tokens = ROW_COUNT;

  UPDATE api_keys t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_api_keys = ROW_COUNT;

  UPDATE mcp_access_tokens t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND t.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_mcp_access_tokens = ROW_COUNT;

  UPDATE mcp_refresh_tokens t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND t.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_mcp_refresh_tokens = ROW_COUNT;

  UPDATE delegation_sessions t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_delegation_sessions = ROW_COUNT;

  UPDATE operator_tokens t SET revoked_at = v_now
   WHERE t.revoked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.subject_user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_operator_tokens = ROW_COUNT;

  UPDATE extension_bridge_codes t SET used_at = v_now
   WHERE t.used_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_extension_bridge_codes = ROW_COUNT;

  UPDATE mobile_bridge_codes t SET used_at = v_now
   WHERE t.used_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_mobile_bridge_codes = ROW_COUNT;

  UPDATE mcp_authorization_codes t SET used_at = v_now
   WHERE t.used_at IS NULL
     AND t.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM tenant_members tm
        WHERE tm.tenant_id = t.tenant_id AND tm.user_id = t.user_id AND tm.deactivated_at IS NULL);
  GET DIAGNOSTICS n_mcp_authorization_codes = ROW_COUNT;

  RAISE NOTICE 'departed-member-credential-residue: users=% sessions=% extension_tokens=% api_keys=% mcp_access_tokens=% mcp_refresh_tokens=% delegation_sessions=% operator_tokens=% extension_bridge_codes=% mobile_bridge_codes=% mcp_authorization_codes=%',
    cardinality(v_users), n_sessions, n_extension_tokens, n_api_keys, n_mcp_access_tokens, n_mcp_refresh_tokens,
    n_delegation_sessions, n_operator_tokens, n_extension_bridge_codes, n_mobile_bridge_codes, n_mcp_authorization_codes;

  PERFORM set_config('app.bypass_rls', COALESCE(v_prev_rls, ''), true);
  PERFORM set_config('app.bypass_tables', COALESCE(v_prev_tables, ''), true);
  PERFORM set_config('app.bypass_purpose', COALESCE(v_prev_purpose, ''), true);
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_tenant, ''), true);
END
$$;
-- END BACKFILL departed-member-credential-residue
