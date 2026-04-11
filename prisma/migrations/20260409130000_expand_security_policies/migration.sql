-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'PASSKEY_ENFORCEMENT_BLOCKED';

-- AlterTable: Tenant — MFA enforcement
ALTER TABLE "tenants" ADD COLUMN "require_passkey" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "require_passkey_enabled_at" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "passkey_grace_period_days" INTEGER;

-- AlterTable: Tenant — Configurable vault lockout
ALTER TABLE "tenants" ADD COLUMN "lockout_threshold_1" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "tenants" ADD COLUMN "lockout_duration_1_minutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "tenants" ADD COLUMN "lockout_threshold_2" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "tenants" ADD COLUMN "lockout_duration_2_minutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "tenants" ADD COLUMN "lockout_threshold_3" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "tenants" ADD COLUMN "lockout_duration_3_minutes" INTEGER NOT NULL DEFAULT 1440;

-- AlterTable: Tenant — Password expiry
ALTER TABLE "tenants" ADD COLUMN "password_max_age_days" INTEGER;
ALTER TABLE "tenants" ADD COLUMN "password_expiry_warning_days" INTEGER NOT NULL DEFAULT 14;

-- AlterTable: Tenant — Audit log retention
ALTER TABLE "tenants" ADD COLUMN "audit_log_retention_days" INTEGER;

-- AlterTable: Tenant — Tenant-wide password policy
ALTER TABLE "tenants" ADD COLUMN "tenant_min_password_length" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN "tenant_require_uppercase" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "tenant_require_lowercase" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "tenant_require_numbers" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "tenant_require_symbols" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: TeamPolicy — Password reuse prevention
ALTER TABLE "team_policies" ADD COLUMN "password_history_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: TeamPolicy — Team IP restriction
ALTER TABLE "team_policies" ADD COLUMN "inherit_tenant_cidrs" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "team_policies" ADD COLUMN "team_allowed_cidrs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
