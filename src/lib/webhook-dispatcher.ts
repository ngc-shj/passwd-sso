/**
 * Webhook dispatcher for team audit events.
 *
 * fire-and-forget: never throws, never blocks the caller.
 * Retries up to 3 times with exponential backoff (1s, 5s, 25s).
 * On final failure, updates failCount/lastFailedAt and logs an audit event.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { logAudit } from "@/lib/audit";
import {
  getMasterKeyByVersion,
  decryptServerData,
} from "@/lib/crypto-server";
import { createHmac } from "node:crypto";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

export interface WebhookEvent {
  type: string;
  teamId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1_000, 5_000, 25_000];

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

async function deliverWithRetry(
  url: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": `sha256=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (res.ok) return true;
    } catch {
      // Network or timeout error
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  return false;
}

/**
 * Dispatch a webhook event to all active webhooks for the given team.
 * fire-and-forget — call with `void dispatchWebhook(...)`.
 */
export function dispatchWebhook(event: WebhookEvent): void {
  void (async () => {
    const webhooks = await withBypassRls(prisma, async () =>
      prisma.teamWebhook.findMany({
        where: {
          teamId: event.teamId,
          isActive: true,
          events: { has: event.type },
        },
      }),
    );

    if (webhooks.length === 0) return;

    const payload = JSON.stringify(event);

    for (const webhook of webhooks) {
      try {
        // Decrypt the HMAC secret
        const masterKey = getMasterKeyByVersion(webhook.masterKeyVersion);
        const secret = decryptServerData(
          {
            ciphertext: webhook.secretEncrypted,
            iv: webhook.secretIv,
            authTag: webhook.secretAuthTag,
          },
          masterKey,
        );

        const signature = computeHmac(secret, payload);
        const ok = await deliverWithRetry(webhook.url, payload, signature);

        await withBypassRls(prisma, async () => {
          if (ok) {
            await prisma.teamWebhook.update({
              where: { id: webhook.id },
              data: {
                lastDeliveredAt: new Date(),
                failCount: 0,
                lastError: null,
              },
            });
          } else {
            const newFailCount = webhook.failCount + 1;
            await prisma.teamWebhook.update({
              where: { id: webhook.id },
              data: {
                failCount: newFailCount,
                lastFailedAt: new Date(),
                lastError: `Delivery failed after ${MAX_RETRIES} attempts`,
                isActive: newFailCount >= 10 ? false : undefined,
              },
            });

            logAudit({
              scope: AUDIT_SCOPE.TEAM,
              action: AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED,
              userId: "system",
              teamId: event.teamId,
              metadata: {
                webhookId: webhook.id,
                url: webhook.url,
                failCount: newFailCount,
              },
            });
          }
        });
      } catch (err) {
        console.error("[webhook-dispatcher] dispatch error", {
          webhookId: webhook.id,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  })().catch(() => {
    // Outer safety net
  });
}
