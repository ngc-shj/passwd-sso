/**
 * Webhook dispatcher for team and tenant audit events.
 *
 * fire-and-forget: never throws, never blocks the caller.
 * Retries up to 3 times with exponential backoff (1s, 5s, 25s).
 * On final failure, updates failCount/lastFailedAt and logs an audit event.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { METADATA_BLOCKLIST } from "@/lib/audit-logger";
import { safeSet } from "@/lib/safe-keys";
import { getLogger } from "@/lib/logger";
import {
  getMasterKeyByVersion,
  decryptServerData,
} from "@/lib/crypto-server";
import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { Agent as UndiciAgent } from "undici";
import { isIpInCidr } from "@/lib/ip-access";
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
  "justification",
  "requestedScope",
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
    const cleaned: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      if (!WEBHOOK_METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeWebhookData(v);
        if (sanitized !== undefined) {
          safeSet(cleaned, k, sanitized);
        }
      }
    }
    return cleaned;
  }
  return value;
}

/**
 * CIDR ranges that must never receive webhook deliveries.
 * Covers RFC 1918, loopback, link-local, cloud metadata, CGNAT,
 * benchmarking, IETF reserved, and IPv6 equivalents.
 */
const BLOCKED_CIDRS = [
  // IPv4
  "10.0.0.0/8",         // RFC 1918
  "172.16.0.0/12",      // RFC 1918
  "192.168.0.0/16",     // RFC 1918
  "127.0.0.0/8",        // loopback
  "0.0.0.0/8",          // "this" network
  "169.254.0.0/16",     // link-local + cloud metadata (169.254.169.254)
  "100.64.0.0/10",      // RFC 6598 CGNAT (also Tailscale)
  "192.0.0.0/24",       // RFC 6890 IETF protocol assignments
  "192.0.2.0/24",       // RFC 5737 TEST-NET-1
  "198.18.0.0/15",      // RFC 2544 benchmarking
  "198.51.100.0/24",    // RFC 5737 TEST-NET-2
  "203.0.113.0/24",     // RFC 5737 TEST-NET-3
  "240.0.0.0/4",        // RFC 1112 reserved
  // IPv6
  "::1/128",            // loopback
  "::/128",             // unspecified
  "fe80::/10",          // link-local
  "fc00::/7",           // unique local (ULA)
  "::ffff:0:0/96",      // IPv4-mapped IPv6 (prevents bypass via ::ffff:127.0.0.1)
];

/**
 * Check if an IP address belongs to a private/reserved range
 * using the existing CIDR matcher from ip-access.ts.
 */
function isPrivateIp(ip: string): boolean {
  return BLOCKED_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

/**
 * Resolve hostname and reject private/reserved IPs to prevent SSRF.
 * Returns the list of validated public IPs for use in IP pinning.
 */
async function resolveAndValidateIps(url: string): Promise<string[]> {
  const hostname = new URL(url).hostname;

  // Already an IP literal — check directly
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) throw new Error(`Private IP rejected: ${hostname}`);
    return [hostname];
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

  return ips;
}

/**
 * Create an undici Agent that pins connections to pre-validated IPs,
 * eliminating the DNS rebinding TOCTOU window between validation and fetch.
 */
function createPinnedDispatcher(hostname: string, validatedIps: string[]): UndiciAgent {
  let index = 0;
  return new UndiciAgent({
    connect: {
      // Preserve TLS certificate validation via SNI
      servername: hostname,
      lookup: (_origin, _opts, cb) => {
        const ip = validatedIps[index % validatedIps.length];
        index++;
        cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
      },
    },
  });
}

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
        const { logAudit } = await import("@/lib/audit");
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

        const { logAudit } = await import("@/lib/audit");
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
      },
    );
  })().catch((err) => {
    getLogger().error({ err }, "webhook dispatch failed");
  });
}
