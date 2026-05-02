-- AlterEnum: add settings IA migration acknowledgement audit action
ALTER TYPE "AuditAction" ADD VALUE 'SETTINGS_IA_MIGRATION_V1_SEEN';
