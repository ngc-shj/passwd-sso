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
import { resolve4, resolve6 } from "node:dns/promises";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { WEBHOOK_CONCURRENCY, WEBHOOK_MAX_RETRIES } from "@/lib/validations/common.server";

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

/**
 * Check if an IP address belongs to a private/reserved range.
 * Blocks RFC 1918, loopback, link-local, and cloud metadata IPs.
 */
function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".");
  const first = parts.length === 4 ? parseInt(parts[0], 10) : NaN;
  const second = parts.length === 4 ? parseInt(parts[1], 10) : NaN;

  // IPv4 reserved ranges
  if (
    ip.startsWith("10.") ||         // RFC 1918
    ip.startsWith("127.") ||        // loopback
    ip.startsWith("0.") ||          // "this" network
    ip === "0.0.0.0" ||
    ip === "255.255.255.255" ||      // broadcast
    ip.startsWith("169.254.") ||     // link-local + cloud metadata
    ip.startsWith("192.168.") ||     // RFC 1918
    ip.startsWith("192.0.0.") ||     // RFC 6890 IETF protocol assignments
    first >= 240                     // RFC 1112 reserved + broadcast
  ) return true;

  // 172.16.0.0/12 — RFC 1918
  if (first === 172 && second >= 16 && second <= 31) return true;

  // 100.64.0.0/10 — RFC 6598 CGNAT (also used by Tailscale)
  if (first === 100 && second >= 64 && second <= 127) return true;

  // 198.18.0.0/15 — RFC 2544 benchmarking
  if (first === 198 && (second === 18 || second === 19)) return true;

  // IPv6 loopback / unspecified / link-local / unique local
  const lower = ip.toLowerCase();
  if (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  ) return true;

  return false;
}

/**
 * Resolve hostname and reject private/reserved IPs to prevent SSRF via DNS rebinding.
 */
async function assertPublicHostname(url: string): Promise<void> {
  const hostname = new URL(url).hostname;

  // Already an IP literal — check directly
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) throw new Error(`Private IP rejected: ${hostname}`);
    return;
  }

  const ips: string[] = [];
  try { ips.push(...await resolve4(hostname)); } catch { /* no A records */ }
  try { ips.push(...await resolve6(hostname)); } catch { /* no AAAA records */ }

  if (ips.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`Hostname ${hostname} resolves to private IP: ${ip}`);
    }
  }
}

async function deliverWithRetry(
  url: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      await assertPublicHostname(url);
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
      console.error("[webhook-dispatcher] secret decryption failed", {
        webhookId: webhook.id,
        masterKeyVersion: webhook.masterKeyVersion,
        error: err instanceof Error ? err.message : "unknown",
      });
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
    console.error("[webhook-dispatcher] dispatch error", {
      webhookId: webhook.id,
      error: err instanceof Error ? err.message : "unknown",
    });
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
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
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
              lastError: `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
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
