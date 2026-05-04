-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'MCP_REFRESH_TOKEN_FAMILY_REVOKED';

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;
