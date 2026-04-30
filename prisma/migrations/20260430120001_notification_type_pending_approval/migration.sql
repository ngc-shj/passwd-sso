-- Add ADMIN_VAULT_RESET_PENDING_APPROVAL to NotificationType enum.
-- Postgres requires ALTER TYPE ADD VALUE to run outside a transaction —
-- Prisma handles this by issuing the statement standalone when the migration
-- contains only ALTER TYPE statements (mirrors the precedent at
-- 20260305010000_tenant_vault_reset_revoke for ADMIN_VAULT_RESET_REVOKED).

ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET_PENDING_APPROVAL';
