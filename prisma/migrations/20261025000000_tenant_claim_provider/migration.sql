-- Claim provenance (plan sso-claim-connection-binding, C3): which SSO provider
-- a tenant claim is bound to, and the same on its routing history.
--
--  - tenant_claims.provider: the provider id sign-in registration recorded, or
--    one an operator bound. NULL = provenance unknown — every row that predates
--    this migration, and what strict binding refuses until it is bound.
--  - tenant_claim_events.old_provider / new_provider: the binding before and
--    after each routing change; NULL on events written before this migration.
--  - the operation CHECK gains 'rebind' (tenant-domain bind).
--
-- The provider-id CHECK spells PROVIDER_ID_PATTERN from
-- src/lib/auth/jackson-providers.ts. A parity test runs one corpus through the
-- TS predicate and each of the three live constraints read from pg_constraint,
-- so change both or neither.
--
-- Wrapped in BEGIN/COMMIT: more than one DDL statement
-- (check-migration-transaction.mjs requires it once ddlCount > 1), and the
-- trigger below names the new column, which must exist and be granted in the
-- same commit.
BEGIN;

ALTER TABLE "tenant_claims" ADD COLUMN "provider" VARCHAR(64);
ALTER TABLE "tenant_claims" ADD CONSTRAINT "tenant_claims_provider_check"
  CHECK ("provider" ~ '^[a-z0-9-]{1,64}$');

ALTER TABLE "tenant_claim_events" ADD COLUMN "old_provider" VARCHAR(64);
ALTER TABLE "tenant_claim_events" ADD COLUMN "new_provider" VARCHAR(64);
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_old_provider_check"
  CHECK ("old_provider" ~ '^[a-z0-9-]{1,64}$');
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_new_provider_check"
  CHECK ("new_provider" ~ '^[a-z0-9-]{1,64}$');

-- Replaced in this SAME transaction by a strict superset of the five values it
-- accepted (baselined in scripts/checks/destructive-migration-baseline.txt), so
-- nothing previously accepted becomes rejected and no other session sees a
-- window between the two statements.
ALTER TABLE "tenant_claim_events" DROP CONSTRAINT "tenant_claim_events_operation_check";
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_operation_check"
  CHECK ("operation" IN ('register', 'revoke', 'unrevoke', 'reassign', 'deregister', 'rebind'));

-- passwd_app holds INSERT on tenant_claim_events column by column
-- (20260731190000), so the two new columns are un-nameable to the sign-in
-- writer until granted. Column grants are additive: no table-level REVOKE runs
-- here, so the existing eight-column grant is untouched. The same list is
-- declared in scripts/checks/app-role-denied-privileges.json `columnGrants`,
-- which bootstrap-rds-roles.mjs re-applies after its convergence REVOKE.
-- old_provider is named by the deregister trigger below, which runs as
-- SECURITY INVOKER, so a delete issued as passwd_app needs it too.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    GRANT INSERT (old_provider, new_provider) ON TABLE tenant_claim_events TO passwd_app;
  END IF;
END $$;

-- The deregister event records the binding the deleted row carried, as every
-- other event records the routing it changed.
CREATE OR REPLACE FUNCTION tenant_claims_record_deregister_event() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  INSERT INTO tenant_claim_events
    (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at,
     actor_label, old_provider, new_provider)
  VALUES
    (gen_random_uuid(), OLD.claim, 'deregister', OLD.tenant_id, NULL, OLD.revoked_at, NULL,
     'db-delete', OLD.provider, NULL);
  RETURN OLD;
END;
$$;

COMMIT;
