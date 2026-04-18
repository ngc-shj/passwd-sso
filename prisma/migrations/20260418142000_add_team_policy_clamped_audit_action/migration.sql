-- Add TEAM_POLICY_CLAMPED_BY_TENANT to the AuditAction enum.
-- Emitted by PATCH /api/tenant/policy when the tenant lowers session idle/absolute
-- and team overrides that exceed the new value are clamped in the same transaction.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TEAM_POLICY_CLAMPED_BY_TENANT';
