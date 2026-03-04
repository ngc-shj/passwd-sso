-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_VAULT_RESET_INITIATE';
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_VAULT_RESET_EXECUTE';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_VAULT_RESET';

-- CreateTable
CREATE TABLE "admin_vault_resets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "initiated_by_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "executed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_vault_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_vault_resets_token_hash_key" ON "admin_vault_resets"("token_hash");

-- CreateIndex
CREATE INDEX "admin_vault_resets_target_user_id_executed_at_revoked_at_idx" ON "admin_vault_resets"("target_user_id", "executed_at", "revoked_at");

-- CreateIndex
CREATE INDEX "admin_vault_resets_tenant_id_idx" ON "admin_vault_resets"("tenant_id");

-- AddForeignKey
ALTER TABLE "admin_vault_resets" ADD CONSTRAINT "admin_vault_resets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_vault_resets" ADD CONSTRAINT "admin_vault_resets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_vault_resets" ADD CONSTRAINT "admin_vault_resets_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_vault_resets" ADD CONSTRAINT "admin_vault_resets_initiated_by_id_fkey" FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
