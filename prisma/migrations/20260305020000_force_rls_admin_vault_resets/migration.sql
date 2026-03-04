-- Force RLS on admin_vault_resets so the policy applies even to table owners.
-- This matches the pattern used by all other tenant-isolated tables.
ALTER TABLE "admin_vault_resets" FORCE ROW LEVEL SECURITY;
