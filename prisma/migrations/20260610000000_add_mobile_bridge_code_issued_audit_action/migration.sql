-- AlterEnum
-- Adds the MOBILE_BRIDGE_CODE_ISSUED audit action emitted by
-- GET /api/mobile/authorize when it issues an iOS device-pairing bridge code.
ALTER TYPE "AuditAction" ADD VALUE 'MOBILE_BRIDGE_CODE_ISSUED';
