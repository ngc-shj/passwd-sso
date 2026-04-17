/**
 * Webhook dispatcher for team and tenant audit events.
 *
 * fire-and-forget: never throws, never blocks the caller.
 * Retries up to 3 times with exponential backoff (1s, 5s, 25s).
 * On final failure, updates failCount/lastFailedAt and logs an audit event.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";
import {
  getMasterKeyByVersion,
  decryptServerData,
} from "@/lib/crypto-server";
import { createHmac } from "node:crypto";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit";
import { WEBHOOK_CONCURRENCY, WEBHOOK_MAX_RETRIES } from "@/lib/validations/common.server";
import { Agent as UndiciAgent } from "undici";
import {
  EXTERNAL_DELIVERY_METADATA_BLOCKLIST,
  sanitizeForExternalDelivery,
  resolveAndValidateIps,
  createPinnedDispatcher,
} from "@/lib/external-http";

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

const RETRY_DELAYS = [1_000, 5_000, 25_000];
const USER_AGENT = "passwd-sso-webhook/1.0";

// ─── Helpers ────────────────────────────────────────────────────

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Recursively strip keys in EXTERNAL_DELIVERY_METADATA_BLOCKLIST. */
const sanitizeWebhookData = sanitizeForExternalDelivery;

async function deliverWithRetry(
  url: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const hostname = new URL(url).hostname;

  for (let attempt = 0; attempt < WEBHOOK_MAX_RETRIES; attempt++) {
    let dispatcher: UndiciAgent | undefined;
    try {
      // Re-resolve DNS on each attempt (IP may legitimately change),
      // but pin the validated IPs for the actual connection.
      const validatedIps = await resolveAndValidateIps(url);
      dispatcher = createPinnedDispatcher(hostname, validatedIps);

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
        // @ts-expect-error -- Node.js fetch supports undici dispatcher
        dispatcher,
      });
      if (res.ok) return true;
    } catch {
      // Network, timeout, or SSRF-blocked error
    } finally {
      dispatcher?.destroy();
    }

    if (attempt < WEBHOOK_MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  return false;
}

async function deliverSingleWebhook(
  webhook: WebhookRecord,
  payload: string,
  onSuccess: (id: string) => Promise<void>,
  onFailure: (id: string, failCount: number, url: string) => Promise<void>,
): Promise<void> {
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
      getLogger().error({ webhookId: webhook.id, masterKeyVersion: webhook.masterKeyVersion, err }, "webhook secret decryption failed");
      return;
    }

    const signature = computeHmac(secret, payload);
    const ok = await deliverWithRetry(webhook.url, payload, signature);

    if (ok) {
      await onSuccess(webhook.id);
    } else {
      await onFailure(webhook.id, webhook.failCount + 1, webhook.url);
    }
  } catch (err) {
    getLogger().error({ webhookId: webhook.id, err }, "webhook dispatch error");
  }
}

/**
 * Shared delivery loop for both team and tenant webhooks.
 * Decrypts HMAC secret, computes signature, delivers with retry.
 * Processes up to WEBHOOK_CONCURRENCY webhooks in parallel per chunk.
 */
async function dispatchToWebhooks(
  webhooks: WebhookRecord[],
  payload: string,
  onSuccess: (id: string) => Promise<void>,
  onFailure: (id: string, failCount: number, url: string) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < webhooks.length; i += WEBHOOK_CONCURRENCY) {
    const chunk = webhooks.slice(i, i + WEBHOOK_CONCURRENCY);
    await Promise.allSettled(
      chunk.map((webhook) =>
        deliverSingleWebhook(webhook, payload, onSuccess, onFailure),
      ),
    );
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
    BYPASS_PURPOSE.WEBHOOK_DISPATCH);

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
        BYPASS_PURPOSE.WEBHOOK_DISPATCH);
      },
      async (id, newFailCount, url) => {
        await withBypassRls(prisma, async () => {
          await prisma.teamWebhook.update({
            where: { id },
            data: {
              failCount: newFailCount,
              lastFailedAt: new Date(),
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
              isActive: newFailCount >= 10 ? false : undefined,
            },
          });
        }, BYPASS_PURPOSE.WEBHOOK_DISPATCH);

        // Lazy import to break circular dependency: webhook-dispatcher.ts ↔ audit.ts
        const { logAuditAsync } = await import("@/lib/audit");
        await logAuditAsync({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          teamId: event.teamId,
          metadata: {
            webhookId: id,
            url,
            failCount: newFailCount,
          },
        });
      },
    );
  })().catch((err) => {
    getLogger().error({ err }, "webhook dispatch failed");
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
    BYPASS_PURPOSE.WEBHOOK_DISPATCH);

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
        BYPASS_PURPOSE.WEBHOOK_DISPATCH);
      },
      async (id, newFailCount, url) => {
        await withBypassRls(prisma, async () => {
          await prisma.tenantWebhook.update({
            where: { id },
            data: {
              failCount: newFailCount,
              lastFailedAt: new Date(),
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
              isActive: newFailCount >= 10 ? false : undefined,
            },
          });
        }, BYPASS_PURPOSE.WEBHOOK_DISPATCH);

        const { logAuditAsync } = await import("@/lib/audit");
        await logAuditAsync({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          tenantId: event.tenantId,
          metadata: {
            webhookId: id,
            url,
            failCount: newFailCount,
          },
        });
      },
    );
  })().catch((err) => {
    getLogger().error({ err }, "webhook dispatch failed");
  });
}
