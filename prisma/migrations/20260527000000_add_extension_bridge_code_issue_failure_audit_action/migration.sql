-- Add EXTENSION_BRIDGE_CODE_ISSUE_FAILURE to the AuditAction enum.
-- Emitted by POST /api/extension/bridge-code on every failure path (IP rate-limit,
-- Origin allowlist miss, body schema reject, unauthenticated, deleted-user,
-- tenant IP restriction deny, step-up required, per-user rate-limit, DPoP fail,
-- DB write failure). Failure cause is recorded in metadata.reason. Companion to
-- the existing EXTENSION_BRIDGE_CODE_ISSUE success-path event.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTENSION_BRIDGE_CODE_ISSUE_FAILURE';
