-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'RATE_LIMIT_FAIL_CLOSED';

-- AlterTable
ALTER TABLE "audit_chain_anchors" ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea;
