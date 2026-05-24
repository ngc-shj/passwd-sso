-- Add EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED to the AuditAction enum.
-- Emitted by POST /api/extension/token (legacy issuance) when a caller
-- hits the deprecated endpoint. The handler now always returns 410 Gone.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED';
