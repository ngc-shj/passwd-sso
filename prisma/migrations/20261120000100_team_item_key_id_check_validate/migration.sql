-- #1011: validate the constraints 20261120000000 added NOT VALID. Each VALIDATE
-- takes SHARE UPDATE EXCLUSIVE on its table: a full scan while reads and
-- writes proceed. A separate migration because 20261120000000 holds ACCESS
-- EXCLUSIVE on both tables until it commits. Constraint validation is not
-- filtered by row-level security, so it scans every row on any role. A
-- violating row fails it with 23514; after 20261120000000 there is none.
--
-- Wrapped in BEGIN/COMMIT: two ALTERs (check-migration-transaction.mjs).
BEGIN;

ALTER TABLE "team_password_entries"
  VALIDATE CONSTRAINT "team_password_entries_item_key_id_iff_item_key";

ALTER TABLE "team_password_entry_histories"
  VALIDATE CONSTRAINT "team_password_entry_histories_v0_no_item_key_id";

COMMIT;
