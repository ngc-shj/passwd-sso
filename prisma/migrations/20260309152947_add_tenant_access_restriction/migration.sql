-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "allowed_cidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tailscale_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tailscale_tailnet" VARCHAR(255);
