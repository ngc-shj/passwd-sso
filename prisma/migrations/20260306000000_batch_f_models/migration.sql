-- CreateEnum
CREATE TYPE "DirectorySyncProvider" AS ENUM ('AZURE_AD', 'GOOGLE_WORKSPACE', 'OKTA');

-- CreateEnum
CREATE TYPE "DirectorySyncStatus" AS ENUM ('IDLE', 'RUNNING', 'SUCCESS', 'ERROR');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'API_KEY_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'API_KEY_REVOKE';
ALTER TYPE "AuditAction" ADD VALUE 'TRAVEL_MODE_ENABLE';
ALTER TYPE "AuditAction" ADD VALUE 'TRAVEL_MODE_DISABLE';
ALTER TYPE "AuditAction" ADD VALUE 'TRAVEL_MODE_DISABLE_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBAUTHN_CREDENTIAL_REGISTER';
ALTER TYPE "AuditAction" ADD VALUE 'WEBAUTHN_CREDENTIAL_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'DIRECTORY_SYNC_CONFIG_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'DIRECTORY_SYNC_CONFIG_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'DIRECTORY_SYNC_CONFIG_DELETE';
ALTER TYPE "AuditAction" ADD VALUE 'DIRECTORY_SYNC_RUN';
ALTER TYPE "AuditAction" ADD VALUE 'DIRECTORY_SYNC_STALE_RESET';

-- AlterEnum
ALTER TYPE "EntryType" ADD VALUE 'SSH_KEY';

-- DropForeignKey
ALTER TABLE "scim_external_mappings" DROP CONSTRAINT IF EXISTS "scim_external_mappings_team_id_fkey";

-- DropForeignKey
ALTER TABLE "scim_tokens" DROP CONSTRAINT IF EXISTS "scim_tokens_team_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "scim_tokens_team_id_revoked_at_idx";

-- AlterTable
ALTER TABLE "scim_external_mappings" DROP COLUMN IF EXISTS "team_id";

-- AlterTable
ALTER TABLE "scim_tokens" DROP COLUMN IF EXISTS "team_id";

-- AlterTable
ALTER TABLE "users" ADD COLUMN "travel_mode_activated_at" TIMESTAMP(3),
ADD COLUMN "travel_mode_active" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "scope" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_type" VARCHAR(32) NOT NULL,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "nickname" VARCHAR(100),
    "prf_encrypted_secret_key" TEXT,
    "prf_secret_key_iv" VARCHAR(24),
    "prf_secret_key_auth_tag" VARCHAR(32),
    "prf_supported" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_sync_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "DirectorySyncProvider" NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 60,
    "encrypted_credentials" TEXT NOT NULL,
    "credentials_iv" VARCHAR(24) NOT NULL,
    "credentials_auth_tag" VARCHAR(32) NOT NULL,
    "status" "DirectorySyncStatus" NOT NULL DEFAULT 'IDLE',
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "last_sync_stats" JSONB,
    "next_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_sync_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_sync_logs" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "DirectorySyncStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "users_created" INTEGER NOT NULL DEFAULT 0,
    "users_updated" INTEGER NOT NULL DEFAULT 0,
    "users_deactivated" INTEGER NOT NULL DEFAULT 0,
    "groups_updated" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,

    CONSTRAINT "directory_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_token_hash_key" ON "api_keys"("token_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_revoked_at_idx" ON "api_keys"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_tenant_id_idx" ON "webauthn_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "directory_sync_configs_next_sync_at_enabled_idx" ON "directory_sync_configs"("next_sync_at", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "directory_sync_configs_tenant_id_provider_key" ON "directory_sync_configs"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "directory_sync_logs_config_id_started_at_idx" ON "directory_sync_logs"("config_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_configs" ADD CONSTRAINT "directory_sync_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_logs" ADD CONSTRAINT "directory_sync_logs_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "directory_sync_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_sync_logs" ADD CONSTRAINT "directory_sync_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: Enable Row Level Security on new tables
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webauthn_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "directory_sync_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "directory_sync_logs" ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true));

CREATE POLICY "webauthn_credentials_tenant_isolation" ON "webauthn_credentials"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true));

CREATE POLICY "directory_sync_configs_tenant_isolation" ON "directory_sync_configs"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true));

CREATE POLICY "directory_sync_logs_tenant_isolation" ON "directory_sync_logs"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true));
