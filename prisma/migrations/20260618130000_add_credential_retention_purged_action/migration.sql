-- SC4: audit action recorded when the retention-gc worker purges an expired
-- forensic credential (after capturing its provenance). Separate migration so
-- the enum value is committed before any usage (Postgres add-then-use hazard).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREDENTIAL_RETENTION_PURGED';
