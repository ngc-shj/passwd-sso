-- iOS AutoFill MVP (Batch A): audit-action enum values for mobile lifecycle.
--
-- Each ALTER TYPE ADD VALUE statement is its own implicit transaction in
-- PostgreSQL — they cannot share one. PostgreSQL >= 12 also requires that an
-- ADDed enum value not be used in the same transaction that creates it, so
-- splitting into separate statements is mandatory regardless of count.

ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_TOKEN_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_TOKEN_REFRESHED';
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_TOKEN_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_TOKEN_REPLAY_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_CACHE_ROLLBACK_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_CACHE_FLAG_FORGED';
