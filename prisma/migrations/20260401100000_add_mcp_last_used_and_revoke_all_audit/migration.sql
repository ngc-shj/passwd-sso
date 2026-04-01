-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'MCP_CONNECTION_REVOKE_ALL';

-- AlterTable
ALTER TABLE "mcp_access_tokens" ADD COLUMN "last_used_at" TIMESTAMP(3);
