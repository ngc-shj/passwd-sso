/**
 * Webhook dispatcher for team and tenant audit events.
 *
 * fire-and-forget: never throws, never blocks the caller.
 * Retries up to 3 times with exponential backoff (1s, 5s, 25s).
 * On final failure, updates failCount/lastFailedAt and logs an audit event.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { logAudit } from "@/lib/audit";
import { METADATA_BLOCKLIST } from "@/lib/audit-logger";
import {
  getMasterKeyByVersion,
  decryptServerData,
} from "@/lib/crypto-server";
import { createHmac } from "node:crypto";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

// ─── Types ──────────────────────────────────────────────────────

export interface TeamWebhookEvent {
  type: string;
  teamId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface TenantWebhookEvent {
  type: string;
  tenantId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** @deprecated Use TeamWebhookEvent instead */
export type WebhookEvent = TeamWebhookEvent;

interface WebhookRecord {
  id: string;
  url: string;
  secretEncrypted: string;
  secretIv: string;
  secretAuthTag: string;
  masterKeyVersion: number;
  failCount: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1_000, 5_000, 25_000];
const USER_AGENT = "passwd-sso-webhook/1.0";

/**
 * Business PII keys to strip from webhook payloads.
 * Superset of METADATA_BLOCKLIST (crypto keys) plus business PII.
 */
export const WEBHOOK_METADATA_BLOCKLIST = new Set([
  ...METADATA_BLOCKLIST,
  "email",
  "targetUserEmail",
  "reason",
  "incidentRef",
  "displayName",
]);

// ─── Helpers ────────────────────────────────────────────────────

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Recursively strip keys in WEBHOOK_METADATA_BLOCKLIST. */
function sanitizeWebhookData(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeWebhookData).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!WEBHOOK_METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeWebhookData(v);
        if (sanitized !== undefined) {
          cleaned[k] = sanitized;
        }
      }
    }
    return cleaned;
  }
  return value;
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
          "User-Agent": USER_AGENT,
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
 * Shared delivery loop for both team and tenant webhooks.
 * Decrypts HMAC secret, computes signature, delivers with retry.
 */
async function dispatchToWebhooks(
  webhooks: WebhookRecord[],
  payload: string,
  onSuccess: (id: string) => Promise<void>,
  onFailure: (id: string, failCount: number, url: string) => Promise<void>,
): Promise<void> {
  for (const webhook of webhooks) {
    try {
      let secret: string;
      try {
        const masterKey = getMasterKeyByVersion(webhook.masterKeyVersion);
        secret = decryptServerData(
          {
            ciphertext: webhook.secretEncrypted,
            iv: webhook.secretIv,
            authTag: webhook.secretAuthTag,
          },
          masterKey,
        );
      } catch (err) {
        console.error("[webhook-dispatcher] secret decryption failed", {
          webhookId: webhook.id,
          masterKeyVersion: webhook.masterKeyVersion,
          error: err instanceof Error ? err.message : "unknown",
        });
        continue;
      }

      const signature = computeHmac(secret, payload);
      const ok = await deliverWithRetry(webhook.url, payload, signature);

      if (ok) {
        await onSuccess(webhook.id);
      } else {
        await onFailure(webhook.id, webhook.failCount + 1, webhook.url);
      }
    } catch (err) {
      console.error("[webhook-dispatcher] dispatch error", {
        webhookId: webhook.id,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Dispatch a webhook event to all active webhooks for the given team.
 * fire-and-forget — call with `void dispatchWebhook(...)`.
 */
export function dispatchWebhook(event: TeamWebhookEvent): void {
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

    const sanitizedEvent = {
      ...event,
      data: sanitizeWebhookData(event.data) as Record<string, unknown>,
    };
    const payload = JSON.stringify(sanitizedEvent);

    await dispatchToWebhooks(
      webhooks,
      payload,
      async (id) => {
        await withBypassRls(prisma, async () =>
          prisma.teamWebhook.update({
            where: { id },
            data: {
              lastDeliveredAt: new Date(),
              failCount: 0,
              lastError: null,
            },
          }),
        );
      },
      async (id, newFailCount, url) => {
        await withBypassRls(prisma, async () => {
          await prisma.teamWebhook.update({
            where: { id },
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
              webhookId: id,
              url,
              failCount: newFailCount,
            },
          });
        });
      },
    );
  })().catch(() => {
    // Outer safety net
  });
}

/**
 * Dispatch a webhook event to all active webhooks for the given tenant.
 * fire-and-forget — call with `void dispatchTenantWebhook(...)`.
 */
export function dispatchTenantWebhook(event: TenantWebhookEvent): void {
  void (async () => {
    const webhooks = await withBypassRls(prisma, async () =>
      prisma.tenantWebhook.findMany({
        where: {
          tenantId: event.tenantId,
          isActive: true,
          events: { has: event.type },
        },
      }),
    );

    if (webhooks.length === 0) return;

    const sanitizedEvent = {
      ...event,
      data: sanitizeWebhookData(event.data) as Record<string, unknown>,
    };
    const payload = JSON.stringify(sanitizedEvent);

    await dispatchToWebhooks(
      webhooks,
      payload,
      async (id) => {
        await withBypassRls(prisma, async () =>
          prisma.tenantWebhook.update({
            where: { id },
            data: {
              lastDeliveredAt: new Date(),
              failCount: 0,
              lastError: null,
            },
          }),
        );
      },
      async (id, newFailCount, url) => {
        await withBypassRls(prisma, async () => {
          await prisma.tenantWebhook.update({
            where: { id },
            data: {
              failCount: newFailCount,
              lastFailedAt: new Date(),
              lastError: `Delivery failed after ${MAX_RETRIES} attempts`,
              isActive: newFailCount >= 10 ? false : undefined,
            },
          });

          logAudit({
            scope: AUDIT_SCOPE.TENANT,
            action: AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED,
            userId: "system",
            tenantId: event.tenantId,
            metadata: {
              webhookId: id,
              url,
              failCount: newFailCount,
            },
          });
        });
      },
    );
  })().catch(() => {
    // Outer safety net
  });
}
