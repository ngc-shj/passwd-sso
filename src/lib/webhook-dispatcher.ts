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
} from "@/lib/crypto/crypto-server";
import { createHmac } from "node:crypto";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { WEBHOOK_CONCURRENCY, WEBHOOK_MAX_RETRIES, WEBHOOK_AUTO_DISABLE_THRESHOLD, WEBHOOK_FETCH_TIMEOUT_MS, WEBHOOK_RETRY_DELAYS_MS } from "@/lib/validations/common.server";
import { Agent as UndiciAgent } from "undici";
import {
  sanitizeForExternalDelivery,
  resolveAndValidateIps,
  createPinnedDispatcher,
} from "@/lib/http/external-http";
import { maskUrlForDisplay } from "@/lib/url/url-validation";

/**
 * Raised when a webhook row's secretAadVersion is below the supported floor.
 * Indicates pending migration (scripts/migrate-webhook-secrets-v1-to-v2.ts).
 */
export class WebhookSecretVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretVersionError";
  }
}

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

import { buildWebhookSecretAAD } from "@/lib/crypto/webhook-aad";

export interface WebhookRecord {
  id: string;
  url: string;
  secretEncrypted: string;
  secretIv: string;
  secretAuthTag: string;
  masterKeyVersion: number;
  /** v1 = legacy no-AAD; v2 = AAD bound to (table, version, ids). */
  secretAadVersion: number;
  /** Required for both kinds. */
  tenantId: string;
  /** Identifies the AAD construction path. */
  kind: "TenantWebhook" | "TeamWebhook";
  /** Present only for kind === "TeamWebhook". */
  teamId?: string | null;
  failCount: number;
}

// ─── Constants ──────────────────────────────────────────────────

const RETRY_DELAYS = WEBHOOK_RETRY_DELAYS_MS;
const USER_AGENT = "passwd-sso-webhook/1.0";

// ─── Helpers ────────────────────────────────────────────────────

function computeHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Compute Stripe-style timestamped signature: HMAC-SHA256 over `${ts}.${body}`.
 * Binding the timestamp into the signed string prevents an attacker from
 * stripping/forging the X-Webhook-Timestamp header — any change to ts changes
 * the signature too. Receivers verify by checking (now - ts) < window AND
 * recomputing v1 over the same `${ts}.${body}` concatenation.
 */
function computeTimestampedHmac(secret: string, timestamp: string, payload: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

/** Recursively strip keys in EXTERNAL_DELIVERY_METADATA_BLOCKLIST. */
const sanitizeWebhookData = sanitizeForExternalDelivery;

interface SignatureHeaders {
  /** Legacy: HMAC-SHA256(secret, body) hex. Receivers should migrate to v1. */
  legacySignature: string;
  /** Stripe-style: HMAC-SHA256(secret, `${ts}.${body}`) hex. */
  v1Signature: string;
  /** ISO-8601 UTC timestamp matching event.timestamp. */
  timestamp: string;
}

async function deliverWithRetry(
  url: string,
  payload: string,
  signatures: SignatureHeaders,
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
          // Legacy header — kept for backward compatibility. Will be removed
          // in a future major version. New receivers should use the v1 below.
          "X-Signature": `sha256=${signatures.legacySignature}`,
          // Stripe-style timestamped signature. Receivers MUST:
          //   1. Reject if Math.abs(now - parseISO(X-Webhook-Timestamp)) > 5min
          //   2. Recompute HMAC over `${X-Webhook-Timestamp}.${body}` and
          //      constant-time compare to the v1 hex in X-Webhook-Signature.
          "X-Webhook-Timestamp": signatures.timestamp,
          "X-Webhook-Signature": `t=${signatures.timestamp},v1=${signatures.v1Signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_FETCH_TIMEOUT_MS),
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
  timestamp: string,
  onSuccess: (id: string) => Promise<void>,
  onFailure: (id: string, failCount: number, url: string) => Promise<void>,
  onError?: (id: string, err: unknown) => Promise<void>,
): Promise<void> {
  try {
    let secret: string;
    try {
      // Post-C4 (OWASP A02-4): v1 (no-AAD) secrets are retired. Any v1 row
      // encountered post-migration is a fail-closed error. Operators must
      // run scripts/migrate-webhook-secrets-v1-to-v2.ts before deploying.
      if (webhook.secretAadVersion < 2) {
        throw new WebhookSecretVersionError(
          `webhook ${webhook.id} has retired secretAadVersion=${webhook.secretAadVersion}; ` +
            `run scripts/migrate-webhook-secrets-v1-to-v2.ts`,
        );
      }
      const masterKey = getMasterKeyByVersion(webhook.masterKeyVersion);
      const aad = buildWebhookSecretAAD({
        tableName: webhook.kind,
        version: webhook.secretAadVersion,
        webhookId: webhook.id,
        tenantId: webhook.tenantId,
        teamId: webhook.kind === "TeamWebhook" ? webhook.teamId ?? null : undefined,
      });
      secret = decryptServerData(
        {
          ciphertext: webhook.secretEncrypted,
          iv: webhook.secretIv,
          authTag: webhook.secretAuthTag,
        },
        masterKey,
        aad,
      );
    } catch (err) {
      getLogger().error(
        {
          webhookId: webhook.id,
          masterKeyVersion: webhook.masterKeyVersion,
          secretAadVersion: webhook.secretAadVersion,
          err,
        },
        "webhook secret decryption failed",
      );
      // Secret-version / key / decrypt failure is RECOVERABLE (a pending key
      // migration or transient key-store error), NOT a delivery attempt that
      // failed. Signal it via onError so the durable delivery path retries the
      // work item instead of marking it SENT and losing the webhook. The
      // fire-and-forget app path passes no onError → unchanged log-and-drop.
      if (onError) await onError(webhook.id, err);
      return;
    }

    const signatures: SignatureHeaders = {
      legacySignature: computeHmac(secret, payload),
      v1Signature: computeTimestampedHmac(secret, timestamp, payload),
      timestamp,
    };
    const ok = await deliverWithRetry(webhook.url, payload, signatures);

    if (ok) {
      await onSuccess(webhook.id);
    } else {
      await onFailure(webhook.id, webhook.failCount + 1, webhook.url);
    }
  } catch (err) {
    // Reaches here on an onSuccess/onFailure DB-update throw (or any unexpected
    // error). Also recoverable — propagate so the durable path can retry.
    getLogger().error({ webhookId: webhook.id, err }, "webhook dispatch error");
    if (onError) await onError(webhook.id, err);
  }
}

/**
 * Shared delivery loop for both team and tenant webhooks — the pure delivery
 * core. Decrypts each HMAC secret, computes the dual signatures, delivers with
 * SSRF-pinned retry, and invokes onSuccess/onFailure per webhook. Holds no
 * prisma/singleton dependency: the caller injects the persistence closures, so
 * the audit-outbox worker can drive it under its own worker prisma + bypass
 * GUCs (see processWebhookDeliveryBatch). Processes up to WEBHOOK_CONCURRENCY
 * webhooks in parallel per chunk.
 */
export async function deliverToWebhookRecords(
  webhooks: WebhookRecord[],
  payload: string,
  timestamp: string,
  onSuccess: (id: string) => Promise<void>,
  onFailure: (id: string, failCount: number, url: string) => Promise<void>,
  onError?: (id: string, err: unknown) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < webhooks.length; i += WEBHOOK_CONCURRENCY) {
    const chunk = webhooks.slice(i, i + WEBHOOK_CONCURRENCY);
    await Promise.allSettled(
      chunk.map((webhook) =>
        deliverSingleWebhook(webhook, payload, timestamp, onSuccess, onFailure, onError),
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
    const rows = await withBypassRls(prisma, async (tx) =>
      tx.teamWebhook.findMany({
        where: {
          teamId: event.teamId,
          isActive: true,
          events: { has: event.type },
        },
      }),
    BYPASS_PURPOSE.WEBHOOK_DISPATCH);

    if (rows.length === 0) return;

    const webhooks: WebhookRecord[] = rows.map((r) => ({
      id: r.id,
      url: r.url,
      secretEncrypted: r.secretEncrypted,
      secretIv: r.secretIv,
      secretAuthTag: r.secretAuthTag,
      masterKeyVersion: r.masterKeyVersion,
      secretAadVersion: r.secretAadVersion,
      tenantId: r.tenantId,
      kind: "TeamWebhook",
      teamId: r.teamId,
      failCount: r.failCount,
    }));

    const sanitizedEvent = {
      ...event,
      data: sanitizeWebhookData(event.data) as Record<string, unknown>,
    };
    const payload = JSON.stringify(sanitizedEvent);

    await deliverToWebhookRecords(
      webhooks,
      payload,
      event.timestamp,
      async (id) => {
        await withBypassRls(prisma, async (tx) =>
          tx.teamWebhook.update({
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
        await withBypassRls(prisma, async (tx) => {
          await tx.teamWebhook.update({
            where: { id },
            data: {
              failCount: newFailCount,
              lastFailedAt: new Date(),
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
              isActive: newFailCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD ? false : undefined,
            },
          });
        }, BYPASS_PURPOSE.WEBHOOK_DISPATCH);

        // Lazy import to break circular dependency: webhook-dispatcher.ts ↔ audit.ts
        const { logAuditAsync } = await import("@/lib/audit/audit");
        await logAuditAsync({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          teamId: event.teamId,
          metadata: {
            webhookId: id,
            url: maskUrlForDisplay(url),
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
    const rows = await withBypassRls(prisma, async (tx) =>
      tx.tenantWebhook.findMany({
        where: {
          tenantId: event.tenantId,
          isActive: true,
          events: { has: event.type },
        },
      }),
    BYPASS_PURPOSE.WEBHOOK_DISPATCH);

    if (rows.length === 0) return;

    const webhooks: WebhookRecord[] = rows.map((r) => ({
      id: r.id,
      url: r.url,
      secretEncrypted: r.secretEncrypted,
      secretIv: r.secretIv,
      secretAuthTag: r.secretAuthTag,
      masterKeyVersion: r.masterKeyVersion,
      secretAadVersion: r.secretAadVersion,
      tenantId: r.tenantId,
      kind: "TenantWebhook",
      failCount: r.failCount,
    }));

    const sanitizedEvent = {
      ...event,
      data: sanitizeWebhookData(event.data) as Record<string, unknown>,
    };
    const payload = JSON.stringify(sanitizedEvent);

    await deliverToWebhookRecords(
      webhooks,
      payload,
      event.timestamp,
      async (id) => {
        await withBypassRls(prisma, async (tx) =>
          tx.tenantWebhook.update({
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
        await withBypassRls(prisma, async (tx) => {
          await tx.tenantWebhook.update({
            where: { id },
            data: {
              failCount: newFailCount,
              lastFailedAt: new Date(),
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
              isActive: newFailCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD ? false : undefined,
            },
          });
        }, BYPASS_PURPOSE.WEBHOOK_DISPATCH);

        const { logAuditAsync } = await import("@/lib/audit/audit");
        await logAuditAsync({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          tenantId: event.tenantId,
          metadata: {
            webhookId: id,
            url: maskUrlForDisplay(url),
            failCount: newFailCount,
          },
        });
      },
    );
  })().catch((err) => {
    getLogger().error({ err }, "webhook dispatch failed");
  });
}
