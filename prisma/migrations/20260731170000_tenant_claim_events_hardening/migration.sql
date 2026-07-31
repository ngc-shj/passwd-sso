-- Hardening pass on the tenant-claim routing history (SC11 / #743), from an
-- external review of the tables added in 20260729110000_add_tenant_claims and
-- 20260731100000_add_tenant_claim_events. Four findings:
--
--  1. (HIGH) passwd_app held UPDATE/DELETE on tenant_claims but no code path
--     uses either verb — only findUnique and nested `claims: { create: … }`.
--     A compromised app role could reassign or revoke a claim's routing
--     directly, with no tenant_claim_events row, defeating the reason that
--     table exists. Closed below by REVOKE, and by registering the table in
--     scripts/checks/app-role-denied-privileges.json so a future table-blind
--     convergence GRANT cannot reopen it.
--  2. (MEDIUM) deleting a tenant cascades away its tenant_claims rows with no
--     event — a recorded, deliberately-deferred gap in the original plan (see
--     docs/archive/review/sso-tenant-claim-event-history-plan.md, C4
--     "Recorded negatives"). The deferral's stated reason — that closing it
--     needs an ambient GUC for the actor label — does not hold: the label is
--     a fixed string, `cascade`, naming the mechanism rather than a person.
--     Closed below with a BEFORE DELETE trigger on tenant_claims.
--  3. (MEDIUM) `tenant_claim_events` has only single-column indexes on
--     `claim` and `created_at`; the operator CLI's `history` command reads it
--     unindexed for its actual query shape (claim + tenant selectors,
--     ordered) and unbounded. Composite indexes added below; the row cap and
--     pagination cursor live in scripts/tenant-domain.ts.
--  4. (LOW) `created_at` is TIMESTAMPTZ(3) and same-millisecond
--     `clock_timestamp()` reads have been observed identical, so two events
--     written in the same millisecond have no defined read order. Closed
--     below with a monotonic `seq` identity column.
--
-- Wrapped in BEGIN/COMMIT: more than one DDL statement
-- (check-migration-transaction.mjs requires it once ddlCount > 1), and a
-- partial apply here would leave privileges revoked without the widened CHECK
-- the new trigger's INSERTs depend on, or vice versa.
BEGIN;

-- ─── Finding 1: passwd_app never uses UPDATE/DELETE on tenant_claims ───────
--
-- 20260729110000_add_tenant_claims granted SELECT, INSERT, UPDATE, DELETE
-- because it followed the convention of every other new-table migration
-- without checking the write surface first. This table's real writers
-- (findOrCreateTenantForClaim's `claims: { create: … }`, and cmdAdd's
-- `updateMany`/`create` — all run as the OPERATOR CLI's privileged role, not
-- passwd_app) never issue UPDATE or DELETE as passwd_app. Revoking them
-- closes the gap the tenant_claim_events table exists to make unnecessary:
-- without this, a compromised app role could rewrite `tenant_id` or clear
-- `revoked_at` directly, leaving no history row at all.
--
-- Registered in scripts/checks/app-role-denied-privileges.json for all three
-- non-owner roles, so bootstrap-rds-roles.mjs re-applies this REVOKE after
-- its blanket convergence GRANT and audit-db-grants.mjs refuses to launder it
-- into the descriptive manifest — the same #745 precedent
-- 20260731100000_add_tenant_claim_events's own privilege layer cites.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE UPDATE, DELETE ON TABLE tenant_claims FROM passwd_app;
  END IF;
END $$;

-- ─── Finding 4: widen the operation CHECK before it is needed ─────────────
--
-- 'deregister' joins the four existing values, mirroring the addition to
-- TENANT_CLAIM_EVENT_OPERATION in src/lib/tenant/tenant-claim-event.ts. Done
-- before the new trigger below so the trigger's own INSERTs are never at risk
-- of racing the constraint that must accept them.
--
-- This DROP is baselined in scripts/checks/destructive-migration-baseline.txt:
-- the constraint is replaced, in this SAME transaction, by a STRICT SUPERSET
-- of the four values it already accepted, so no value that was accepted
-- before this migration becomes rejected after it. There is no window in
-- between: DDL inside one transaction is not visible to any other session
-- until COMMIT.
ALTER TABLE "tenant_claim_events" DROP CONSTRAINT "tenant_claim_events_operation_check";
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_operation_check"
  CHECK ("operation" IN ('register', 'revoke', 'unrevoke', 'reassign', 'deregister'));

-- ─── Finding 2: a tenant deletion must not cascade away its claims silently ─
--
-- tenant_claims.tenant_id has ON DELETE CASCADE (20260729110000). Before this
-- trigger, that cascade removed a tenant's tenant_claims rows with no trace
-- in tenant_claim_events — the exact "destroys its own evidence" shape SC11
-- exists to close for `add --from` and un-revoke, left open for this one path
-- because the original plan believed closing it needed an ambient GUC to
-- supply the actor label (see the plan's C4 "Recorded negatives", and the
-- correction recorded alongside this migration in
-- docs/archive/review/sso-tenant-claim-event-history-deviation.md). It does
-- not: 'cascade' below is a fixed string naming the MECHANISM, the same way
-- 'signin' already names the sign-in auto-registration path rather than a
-- person, not an attempt to attribute the deletion to whoever issued it — the
-- `db_user`/`session_db_user` pair the tenant_claim_events BEFORE INSERT
-- trigger assigns unconditionally already carries that.
--
-- SECURITY INVOKER (the default, stated explicitly — a caller with definer
-- rights would make current_user in the tenant_claim_events INSERT trigger a
-- constant, the same I2 concern the sibling triggers already carry).
--
-- This trigger does NOT need the escape GUC the append-only triggers on
-- tenant_claim_events read: it only ever INSERTs into that table, and INSERT
-- is unconditionally allowed there (the append-only triggers fire on
-- UPDATE/DELETE/TRUNCATE, never INSERT). The tenant_claim_events BEFORE
-- INSERT trigger assigns db_user/session_db_user/client_addr/created_at on
-- this INSERT exactly as it does on every other one; this function supplies
-- none of them.
CREATE FUNCTION tenant_claims_record_deregister_event() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  INSERT INTO tenant_claim_events
    (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
  VALUES
    (gen_random_uuid(), OLD.claim, 'deregister', OLD.tenant_id, NULL, OLD.revoked_at, NULL, 'cascade');
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_tenant_claims_record_deregister_event
  BEFORE DELETE ON "tenant_claims"
  FOR EACH ROW EXECUTE FUNCTION tenant_claims_record_deregister_event();

-- ENABLE ALWAYS for the same reason as tenant_claim_events' own triggers
-- (20260731100000): a default 'O' trigger does not fire under
-- session_replication_role = 'replica', which this repo already sets inside
-- a migration (20260321100000_unify_all_ids_to_uuid). A silent trigger here
-- reopens exactly the gap this migration exists to close.
ALTER TABLE "tenant_claims" ENABLE ALWAYS TRIGGER trg_tenant_claims_record_deregister_event;

-- ─── Finding 3: index the shape tenant-domain history actually queries ────
--
-- cmdHistory filters on `claim` (equality) or on `old_tenant_id OR
-- new_tenant_id` (equality), then orders the result — now by `seq` (below),
-- displaying `created_at`. Composite, not single-column: the existing
-- `claim` and `created_at` indexes from 20260731100000 support neither
-- selector-plus-order query well, and a claim or tenant with a long history
-- forced a sequential scan. `id` is the third column for a stable read order
-- on ties within one (selector, created_at) pair; it is NOT what makes the
-- ORDER BY monotonic across a shared millisecond — id is a random UUID
-- (`uuid(4)`) with no relation to insertion order, which is exactly why
-- Finding 4's `seq` column exists and is what cmdHistory actually orders by.
--
-- The single-column `claim`/`created_at` indexes from 20260731100000 are left
-- in place rather than dropped: they are now redundant for `history`'s own
-- queries, but dropping them widens this migration's already-baselined DROP
-- surface for a storage saving on a table this deployment expects to stay
-- small (one row per operator mutation, plus one per first-ever tenant
-- creation — see the original migration's SC-A). Revisit only if this table's
-- size ever makes that redundancy worth the review cost.
CREATE INDEX "tenant_claim_events_claim_created_at_id_idx"
  ON "tenant_claim_events"("claim", "created_at", "id");
CREATE INDEX "tenant_claim_events_old_tenant_id_created_at_id_idx"
  ON "tenant_claim_events"("old_tenant_id", "created_at", "id");
CREATE INDEX "tenant_claim_events_new_tenant_id_created_at_id_idx"
  ON "tenant_claim_events"("new_tenant_id", "created_at", "id");

-- ─── Finding 4: monotonic ordering across a shared millisecond ────────────
--
-- GENERATED ALWAYS AS IDENTITY, not a DEFAULT: the same forgeability the
-- tenant_claim_events BEFORE INSERT trigger already closes for
-- db_user/session_db_user/created_at applies here too — a plain DEFAULT is
-- overridable by any INSERT that names the column, and this table's whole
-- purpose is columns nothing but the engine can set. An identity column
-- cannot be overridden by application INSERT text at all (it raises unless
-- OVERRIDING SYSTEM VALUE is stated explicitly, which no writer in this
-- codebase does or should).
--
-- Backfills every existing row: PostgreSQL assigns each one a value from the
-- new sequence when the column is added, so no row is left without one.
-- Kept as a plain BIGINT with a UNIQUE constraint (below), not the primary
-- key — `id` (UUID) stays the identity every foreign reference and every
-- existing call site already uses; `seq` exists only to answer "which of two
-- rows came first."
ALTER TABLE "tenant_claim_events" ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_seq_key" UNIQUE ("seq");

-- The identity sequence is new attack surface this migration creates, and the
-- default ACL grants passwd_app SELECT+USAGE on it automatically. SELECT there
-- exposes last_value — an event counter — to the one role deliberately denied
-- SELECT on the table itself, which partly undoes that containment. It is also
-- the ONLY sequence any audited role would hold rights on: every other table in
-- this schema uses a UUID key, so this is not the repo's normal shape.
--
-- Measured before revoking, because the sign-in writer is fail-closed and a
-- broken INSERT here denies first-ever sign-ins: an INSERT into a
-- GENERATED ALWAYS AS IDENTITY column succeeds with NO privileges on the
-- backing sequence (unlike a serial/DEFAULT nextval column, which needs USAGE).
--
-- Not expressible in app-role-denied-privileges.json — that policy's subject is
-- a table and its privilege set has no USAGE — so it is stated here instead.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE ALL ON SEQUENCE public.tenant_claim_events_seq_seq FROM passwd_app;
  END IF;
END $$;

COMMIT;
