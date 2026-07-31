-- Append-only history of tenant-claim routing changes (SC11 / issue #743).
--
-- `tenant-domain add --from` overwrites `tenant_claims.tenant_id` and the
-- un-revoke path nulls `tenant_claims.revoked_at`; each destroys the state it
-- changed, so afterwards the row is indistinguishable from one registered once
-- and never touched. This table is the record those two operations do not keep.
--
-- Wrapped in BEGIN/COMMIT because this migration has more than one DDL
-- statement (check-migration-transaction.mjs requires it once ddlCount > 1).
BEGIN;

-- WHY THIS TABLE HAS NO `tenant_id` AND NO FOREIGN KEYS — read before "fixing"
-- what looks like an omission:
--
--  * No FK to `tenant_claims`: ON DELETE CASCADE would destroy exactly the
--    history being kept. The claim is stored as a string.
--  * No FK to `tenants` and no `tenant_id` column: a reassignment names the
--    LOSING and the GAINING tenant in ONE row (splitting it across two rows
--    reproduces the "one incident, two groups" defect recorded as D-33 in
--    docs/archive/review/sso-tenant-domain-alias-deviation.md), and a row
--    naming two tenants cannot be attributed to one.
--  * Therefore this table is OUTSIDE the maintenance contract at the head of
--    scripts/rls-cross-tenant-tables.manifest, BY CONSTRUCTION and not by
--    oversight: that contract's discovery predicate (see
--    scripts/rls-cross-tenant-verify.sql, check 5) is "has a tenant_id column"
--    / "has a <table>_tenant_isolation policy", and this table has neither.
--    The manifest total stays 56.
--  * And therefore no ENABLE/FORCE ROW LEVEL SECURITY: with no tenant_id there
--    is no isolation predicate to write, and FORCE with no policy would deny
--    the INSERT the sign-in auto-registration path needs. Containment is the
--    revoked SELECT below, registered in
--    scripts/checks/app-role-denied-privileges.json so a table-blind
--    convergence GRANT cannot re-open it.
CREATE TABLE "tenant_claim_events" (
    "id" UUID NOT NULL,
    "claim" VARCHAR(255) NOT NULL,
    "operation" VARCHAR(16) NOT NULL,
    "old_tenant_id" UUID,
    "new_tenant_id" UUID,
    "old_revoked_at" TIMESTAMPTZ(3),
    "new_revoked_at" TIMESTAMPTZ(3),
    "actor_label" VARCHAR(255) NOT NULL,
    -- 63 = NAMEDATALEN - 1, the maximum length of a PostgreSQL role name. A
    -- shorter bound would turn a long role name into a failed INSERT, and the
    -- sign-in writer is fail-closed, so that would deny first-ever sign-ins.
    "db_user" VARCHAR(63) NOT NULL,
    "session_db_user" VARCHAR(63) NOT NULL,
    -- Nullable: inet_client_addr() is NULL over a Unix-domain socket, which is
    -- an ordinary way to run the operator CLI on the database host.
    "client_addr" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_claim_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_claim_events_claim_idx" ON "tenant_claim_events"("claim");
CREATE INDEX "tenant_claim_events_created_at_idx" ON "tenant_claim_events"("created_at");

-- The four operations, mirroring TENANT_CLAIM_EVENT_OPERATION in
-- src/lib/tenant/tenant-claim-event.ts. A drift test asserts this list and that
-- const-object agree by reading pg_get_constraintdef from the LIVE catalogue —
-- a migration file is immutable once applied, so the file is not the authority.
--
-- Deliberately a CHECK and not a Postgres/Prisma enum: an enum costs an
-- ALTER TYPE migration plus the AUDIT_ACTION-shaped bookkeeping (value arrays,
-- group arrays, two i18n files) and buys nothing here.
--
-- NOTE: these values are not a partition of outcomes. `add --from` against a
-- revoked row is simultaneously a reassignment and an un-revoke, and is
-- recorded as 'reassign'. Revocation-state questions are answered from
-- old_revoked_at/new_revoked_at, never by filtering `operation`.
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_operation_check"
  CHECK ("operation" IN ('register', 'revoke', 'unrevoke', 'reassign'));

-- Same predicate `tenant_claims` applies to its own claim column, and pinned to
-- it deliberately: this CHECK sits on the fail-closed sign-in write path, so a
-- STRICTER predicate here than the one `storableClaimSchema` already enforced
-- upstream would deny a sign-in whose claim the registry itself accepted.
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_claim_normalized"
  CHECK ("claim" = lower("claim" COLLATE "C") AND "claim" = btrim("claim")
         AND "claim" <> '' AND "claim" !~ '[^\x20-\x7E]');

-- Every row names at least one tenant. Without this, a row naming neither is
-- unreachable by the tenant-scoped purge routine below and by
-- `tenant-domain history --tenant`, i.e. permanently un-cleanable on a shared
-- development database and invisible to the tool that exists to read it.
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_names_a_tenant"
  CHECK ("old_tenant_id" IS NOT NULL OR "new_tenant_id" IS NOT NULL);

-- ─── Attribution: assigned by the engine, never by the caller ───────────────
--
-- SECURITY INVOKER (the default, stated explicitly) is load-bearing: with
-- definer rights, current_user would be this function's owner and the
-- attribution would be a constant dressed as evidence.
--
-- current_user AND session_user, because they differ and the difference is the
-- point: current_user follows SET ROLE and a definer-rights context,
-- session_user does not, so the pair distinguishes "who acted" from "who
-- authenticated".
--
-- created_at is assigned here too, so it is neither caller-supplied nor a
-- column DEFAULT. clock_timestamp(), NOT now()/CURRENT_TIMESTAMP: those return
-- TRANSACTION START time, and the operator CLI runs its confirmation prompt
-- inside the open transaction (deliberately — see D-14), so now() would record
-- when the operator began reading the warning rather than when the change
-- happened.
CREATE FUNCTION tenant_claim_events_set_principal() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  NEW.db_user := current_user;
  NEW.session_db_user := session_user;
  NEW.client_addr := inet_client_addr();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_claim_events_set_principal
  BEFORE INSERT ON "tenant_claim_events"
  FOR EACH ROW EXECUTE FUNCTION tenant_claim_events_set_principal();

-- ─── Append-only ───────────────────────────────────────────────────────────
--
-- UPDATE and TRUNCATE always raise. DELETE raises unless the purge routine
-- below is the caller: that routine is the only sanctioned producer of the
-- escape GUC, and it carries it as a function-level SET so the setting is
-- restored when the routine returns.
--
-- The GUC has a dedicated name and is deliberately NOT the one withBypassRls()
-- sets: every request in the application sets that one, so reusing it would
-- hand the delete capability to the entire sign-in path.
--
-- What this trigger does NOT do, stated so it is not over-read: it does not
-- bind the table owner. Any role holding DELETE can set the GUC by hand, and
-- the owner can DROP or DISABLE this trigger outright. The BOUND is the table
-- ACL below — this is the layer that covers accident, and the roles the ACL
-- does not reach.
CREATE FUNCTION tenant_claim_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND COALESCE(current_setting('app.allow_claim_event_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tenant_claim_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_tenant_claim_events_append_only
  BEFORE UPDATE OR DELETE ON "tenant_claim_events"
  FOR EACH ROW EXECUTE FUNCTION tenant_claim_events_append_only();

-- TRUNCATE is a SEPARATE trigger event: a row-level BEFORE DELETE trigger does
-- not fire on it. Without this, the one statement that destroys the entire
-- history is the one the control cannot see, and it destroys it silently.
CREATE TRIGGER trg_tenant_claim_events_no_truncate
  BEFORE TRUNCATE ON "tenant_claim_events"
  FOR EACH STATEMENT EXECUTE FUNCTION tenant_claim_events_append_only();

-- ENABLE ALWAYS on all three. A trigger created with the default tgenabled='O'
-- does NOT fire under session_replication_role = 'replica', which this
-- repository already sets inside a migration
-- (20260321100000_unify_all_ids_to_uuid), so it is an established idiom here
-- rather than a hypothetical. On the INSERT trigger the consequence is the
-- worst of the three: with it silent, an INSERT that names db_user stores the
-- SUPPLIED value, so the attribution becomes forgeable rather than merely
-- absent.
ALTER TABLE "tenant_claim_events" ENABLE ALWAYS TRIGGER trg_tenant_claim_events_set_principal;
ALTER TABLE "tenant_claim_events" ENABLE ALWAYS TRIGGER trg_tenant_claim_events_append_only;
ALTER TABLE "tenant_claim_events" ENABLE ALWAYS TRIGGER trg_tenant_claim_events_no_truncate;

-- ─── The one sanctioned deletion path ──────────────────────────────────────
--
-- Exists because integration tests must be able to remove their own rows on a
-- shared development database; without it the suite is un-runnable, not merely
-- untidy. A bare GUC could not be the answer: an unregistered two-part custom
-- GUC is a PGC_USERSET placeholder that any role may set, so it would leave no
-- trace and bound nothing.
--
-- The function-level SET is the whole mechanism. `PERFORM set_config(..., true)`
-- inside the body would NOT work: SET LOCAL issued inside a plpgsql body
-- persists to the end of the CALLER's transaction, so calling this from a test
-- cleanup routine would leave the append-only trigger disarmed for every
-- following statement in that transaction. A function-level SET is saved on
-- entry and restored on exit, including on error.
--
-- SECURITY INVOKER, not DEFINER: 20260725140000_revoke_definer_execute_from_public
-- put `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` in
-- force and bootstrap-rds-roles.mjs issues no function grants, so this routine
-- is owner-only wherever the SAME role ran both migrations — that statement
-- carries no FOR ROLE, so it binds objects created by the role that executed
-- it, and the migration-running role is environment-dependent (passwd_user
-- locally, postgres in CI). Calibrated deliberately rather than left as
-- "owner-only from birth": that absolute is what a future reader would lean on
-- to justify a DEFINER conversion or a GRANT EXECUTE.
--
-- Either way the BOUND is the table ACL, not this routine's own: with invoker
-- rights a caller still needs DELETE on the table, which passwd_app and both
-- worker roles are prescriptively denied. Definer rights would remove exactly
-- that property, handing evidence deletion to any role a future GRANT EXECUTE
-- names.
--
-- BLAST RADIUS, stated because it is wider than the argument suggests: a
-- reassignment is ONE row naming TWO tenants, so purging either side removes
-- the record for both. That follows from the one-row design, not from this
-- predicate; the alternative (delete only when both named tenants are in
-- scope) would leave such a row unreachable by any single-tenant purge.
CREATE FUNCTION tenant_claim_events_purge_for_tenant(p_tenant_id UUID)
  RETURNS BIGINT
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET app.allow_claim_event_purge = 'on'
AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  DELETE FROM tenant_claim_events
   WHERE old_tenant_id = p_tenant_id OR new_tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ─── Privilege layer: this is the bound ────────────────────────────────────
--
-- The default ACL (DEFAULTACL:passwd_user public r passwd_app=arwd/passwd_user)
-- pre-grants arwd on every new table, so the REVOKE is load-bearing rather than
-- decorative. The sign-in auto-registration path needs INSERT and nothing else:
-- no SELECT, which is why the event writer issues a raw INSERT with no
-- RETURNING (RETURNING requires SELECT on the returned columns).
--
-- Registered for all three non-owner roles in
-- scripts/checks/app-role-denied-privileges.json, so bootstrap-rds-roles.mjs
-- re-applies these REVOKEs after its blanket convergence GRANT and
-- audit-db-grants.mjs refuses to launder them into the descriptive manifest.
--
-- No grants for passwd_outbox_worker or passwd_retention_gc_worker: this table
-- is not retention-GC'd, which is the point of it.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE ALL ON TABLE tenant_claim_events FROM passwd_app;
    GRANT INSERT ON TABLE tenant_claim_events TO passwd_app;
  END IF;
END $$;

COMMIT;
