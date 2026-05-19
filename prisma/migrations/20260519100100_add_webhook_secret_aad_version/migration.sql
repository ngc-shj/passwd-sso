-- Add secret_aad_version to tenant_webhooks and team_webhooks.
-- v1: legacy AES-GCM with no AAD. v2: AAD-bound to (tableName | version | webhookId | tenantId | teamId?).
-- New rows default to v1 at the schema level; route handlers MUST set v2 explicitly on every new write.

ALTER TABLE "team_webhooks"   ADD COLUMN "secret_aad_version" INT NOT NULL DEFAULT 1;
ALTER TABLE "tenant_webhooks" ADD COLUMN "secret_aad_version" INT NOT NULL DEFAULT 1;
