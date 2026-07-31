-- Second hardening pass on the tenant-claim routing history (SC11 / #743), from
-- the external review of 20260731170000_tenant_claim_events_hardening. Four
-- findings; three are closed here, the fourth (a shell-quoting defect in the
-- operator CLI's continuation hint) is not a database concern and is closed in
-- scripts/tenant-domain.ts.
--
--  1. (HIGH) `seq` is GENERATED ALWAYS AS IDENTITY, which 20260731170000
--     described as "cannot be overridden by application INSERT text at all".
--     Measured on a throwaway database, that is wrong: a TABLE-level INSERT
--     grant is sufficient for `OVERRIDING SYSTEM VALUE`, and passwd_app holds
--     one. Closed below by scoping the grant to columns.
--  2. (MEDIUM) the composite indexes 20260731170000 added are ordered by
--     `created_at`, but the same migration made `seq` the read order and the
--     pagination cursor, so the operator CLI's actual query used none of them.
--     Replaced below.
--  3. (LOW) the `tenant_claims` BEFORE DELETE trigger labels every row it
--     writes `cascade`, but a BEFORE DELETE trigger cannot distinguish a
--     cascade from a direct DELETE. Relabelled below.
--
-- Wrapped in BEGIN/COMMIT: more than one DDL statement
-- (check-migration-transaction.mjs requires it once ddlCount > 1), and the
-- REVOKE/GRANT pair in finding 1 must not be separable — the window between
-- them is one in which the sign-in writer holds no INSERT at all.
BEGIN;

-- ─── Finding 1: scope passwd_app's INSERT to the columns its writers name ──
--
-- `GENERATED ALWAYS AS IDENTITY` rejects a plain `INSERT … (seq) VALUES (…)`,
-- which is what 20260731170000's claim rested on. It does NOT reject
-- `INSERT … (seq, …) OVERRIDING SYSTEM VALUE VALUES (…)`, and no additional
-- privilege is required for that form beyond the table-level INSERT the role
-- already held. Measured, both directions, on a throwaway database and role:
--
--   table-level INSERT   -> OVERRIDING SYSTEM VALUE succeeds
--   column-level INSERT  -> OVERRIDING SYSTEM VALUE raises 42501
--                           (`seq` is simply not in the granted column set)
--
-- Why that is worth a migration. `seq` carries a UNIQUE constraint, so a row
-- planted at the top of the range makes every subsequent engine-assigned value
-- collide, and the event writer is fail-closed: the failure surfaces as denied
-- first-ever sign-ins and refused operator claim changes, not as a missing
-- history row. A negative value is the mirror image — it sorts before every
-- real row and sits outside what the CLI's `--after` cursor can name.
--
-- The column list is exactly what the two writers name — src/lib/tenant/
-- tenant-claim-event.ts's raw INSERT, and the tenant_claims BEFORE DELETE
-- trigger below. It leaves `db_user`, `session_db_user`, `client_addr` and
-- `created_at` un-granted, which is a second thing this buys: those four were
-- previously unforgeable only because a BEFORE INSERT trigger overwrites
-- whatever a caller supplies, and are now un-nameable as well. A statement
-- that lists them raises 42501 before the trigger runs at all.
--
-- Order is load-bearing and the two halves cannot be reordered or split:
-- `REVOKE <priv> ON TABLE` erases the COLUMN-level grants of that privilege
-- too (measured — pg_attribute.attacl goes empty), so a re-grant must follow
-- every revoke. That is also why this pair is now declared in
-- scripts/checks/app-role-denied-privileges.json as a `columnGrants` entry
-- rather than left to this file: scripts/bootstrap-rds-roles.mjs re-applies
-- the declared REVOKEs after its blanket `GRANT … ON ALL TABLES`, and without
-- the declaration it would have revoked the column grants on every
-- convergence run with nothing to put them back.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN
    REVOKE INSERT ON TABLE tenant_claim_events FROM passwd_app;
    GRANT INSERT (id, claim, operation, old_tenant_id, new_tenant_id,
                  old_revoked_at, new_revoked_at, actor_label)
      ON TABLE tenant_claim_events TO passwd_app;
  END IF;
END $$;

-- Defence in depth behind that ACL, not a substitute for it: the ACL is what
-- stops a value being supplied, and this is what stops a supplied value being
-- nonsensical if a future migration ever re-grants table-level INSERT. `seq`
-- is a cursor as well as an ordering — `tenant-domain history --after <seq>`
-- accepts non-negative integers only — so a zero or negative row would be
-- ordered before every real event and unreachable by any cursor the CLI can
-- produce. Identity sequences start at 1, so no existing row can violate this.
ALTER TABLE "tenant_claim_events" ADD CONSTRAINT "tenant_claim_events_seq_positive"
  CHECK ("seq" > 0);

-- ─── Finding 2: index the order the reader actually uses ──────────────────
--
-- 20260731170000 added (selector, created_at, id) indexes in the same
-- transaction that made `seq` the ORDER BY and the pagination cursor, so a
-- leading-column match left the planner with no usable ordering — the external
-- review's EXPLAIN reported a sequential scan plus a sort. (selector, seq)
-- serves the filter, the sort and the `seq > :after` range in one index.
--
-- Measured after the replacement, on 41k rows with a tenant naming 660 of them:
-- each single-column equality is an ordered `Index Scan` feeding `Limit` with
-- no sort node at all. The `OR` form that `tenant-domain history --tenant` used
-- to emit does use these indexes, as a `BitmapOr` — but a bitmap scan is
-- unordered, so that plan still sorts every matching row before the cap
-- applies. Which is why the CLI now issues one query per side and merges them;
-- see cmdHistory.
--
-- Dropped rather than left alongside the replacements — baselined in
-- scripts/checks/destructive-migration-baseline.txt. Nothing reads an index by
-- name, so no old application code can be broken by their absence, and the
-- three have never existed outside this unmerged branch. They are not free
-- either: every one of them is write amplification on the fail-closed sign-in
-- path.
--
-- The single-column `claim`/`created_at` indexes from 20260731100000 are left
-- alone, as 20260731170000 decided; that call is unchanged by this one.
DROP INDEX "tenant_claim_events_claim_created_at_id_idx";
DROP INDEX "tenant_claim_events_old_tenant_id_created_at_id_idx";
DROP INDEX "tenant_claim_events_new_tenant_id_created_at_id_idx";

CREATE INDEX "tenant_claim_events_claim_seq_idx"
  ON "tenant_claim_events"("claim", "seq");
CREATE INDEX "tenant_claim_events_old_tenant_id_seq_idx"
  ON "tenant_claim_events"("old_tenant_id", "seq");
CREATE INDEX "tenant_claim_events_new_tenant_id_seq_idx"
  ON "tenant_claim_events"("new_tenant_id", "seq");

-- ─── Finding 3: name the mechanism that is actually observable ────────────
--
-- 20260731170000 argued that `cascade` names a MECHANISM rather than a person,
-- the way `signin` does. The argument holds; the label does not. A BEFORE
-- DELETE trigger fires identically for a cascade from `DELETE FROM tenants`
-- and for a direct `DELETE FROM tenant_claims`, and nothing available inside
-- it distinguishes the two — so on a direct delete the row asserted a cascade
-- that never happened, on the one table whose purpose is to be believed later.
--
-- `db-delete` is what the trigger can actually vouch for: the row was removed
-- from `tenant_claims` by a DELETE. Which delete, and by whom, is answered by
-- the `db_user` / `session_db_user` pair the tenant_claim_events BEFORE INSERT
-- trigger assigns on this INSERT like any other.
--
-- Rows already written by the previous definition keep saying `cascade`. That
-- is not a backfill this migration declined to do — the table is append-only
-- and UPDATE raises, and rewriting recorded history to match a later opinion
-- about its wording is the behaviour this table exists to make impossible.
CREATE OR REPLACE FUNCTION tenant_claims_record_deregister_event() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  INSERT INTO tenant_claim_events
    (id, claim, operation, old_tenant_id, new_tenant_id, old_revoked_at, new_revoked_at, actor_label)
  VALUES
    (gen_random_uuid(), OLD.claim, 'deregister', OLD.tenant_id, NULL, OLD.revoked_at, NULL, 'db-delete');
  RETURN OLD;
END;
$$;

COMMIT;
