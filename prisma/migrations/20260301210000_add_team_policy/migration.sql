-- CreateTable
CREATE TABLE "team_policies" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "min_password_length" INTEGER NOT NULL DEFAULT 0,
    "require_uppercase" BOOLEAN NOT NULL DEFAULT false,
    "require_lowercase" BOOLEAN NOT NULL DEFAULT false,
    "require_numbers" BOOLEAN NOT NULL DEFAULT false,
    "require_symbols" BOOLEAN NOT NULL DEFAULT false,
    "max_session_duration_minutes" INTEGER,
    "require_reprompt_for_all" BOOLEAN NOT NULL DEFAULT false,
    "allow_export" BOOLEAN NOT NULL DEFAULT true,
    "allow_sharing" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_policies_team_id_key" ON "team_policies"("team_id");

-- CreateIndex
CREATE INDEX "team_policies_tenant_id_idx" ON "team_policies"("tenant_id");

-- AddForeignKey
ALTER TABLE "team_policies" ADD CONSTRAINT "team_policies_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_policies" ADD CONSTRAINT "team_policies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security
ALTER TABLE "team_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_policies" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "team_policies"
    USING ("tenant_id" = current_setting('app.tenant_id', true));
