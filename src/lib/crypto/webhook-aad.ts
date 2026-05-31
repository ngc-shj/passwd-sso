/**
 * AAD construction for AES-GCM-encrypted webhook secrets.
 *
 * Thin wrapper around the single registry in crypto-aad.ts.
 * Returns Buffer so the 3 consumers (webhook-dispatcher.ts,
 * app/api/teams/[teamId]/webhooks/route.ts,
 * app/api/tenant/webhooks/route.ts) that pass the result to
 * crypto-server's Buffer-typed AAD stay unchanged.
 */

import {
  buildWebhookSecretAAD as buildWebhookSecretAADBytes,
  type WebhookSecretAADArgs,
} from "@/lib/crypto/crypto-aad";

export type { WebhookSecretAADArgs };
export type WebhookKind = "TenantWebhook" | "TeamWebhook";

export function buildWebhookSecretAAD(args: WebhookSecretAADArgs): Buffer {
  return Buffer.from(buildWebhookSecretAADBytes(args));
}

/** Current AAD version emitted on new writes. */
export const WEBHOOK_SECRET_AAD_VERSION_CURRENT = 2;
