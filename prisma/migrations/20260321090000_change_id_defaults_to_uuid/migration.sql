-- Change ID default from cuid() to uuid(4) for models with client-generated UUIDs (AAD-bound).
-- This only modifies catalog metadata (pg_attrdef) — no table rewrite, no exclusive lock.

ALTER TABLE "password_entries" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "team_password_entries" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "teams" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "attachments" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
