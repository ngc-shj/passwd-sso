/**
 * Per-resource quota enforcement for create-class endpoints.
 *
 * C18 / OWASP A04-1: prevents authenticated attackers (compromised SCIM
 * token, malicious member) from exhausting DB / object storage by mass-
 * creating passwords / attachments / share-links / webhooks.
 *
 * Pre-1.0 soft-cap: COUNT/SUM → check → INSERT is not atomic. Concurrent
 * requests at the boundary may overshoot by N where N = concurrent insert
 * count. Documented; hard-cap (advisory lock / partial-index pattern)
 * deferred to plan-based per-tier quotas.
 *
 * Error envelope: `quota_exceeded` (HTTP 403), distinct from `rate_limit`
 * (429) — quota is a stable limit; rate limit is a throttle.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export type QuotaResource =
  | "passwords"
  | "attachment_bytes"
  | "share_links"
  | "webhooks";

export class QuotaExceededError extends Error {
  constructor(
    public readonly resource: QuotaResource,
    public readonly current: number,
    public readonly max: number,
  ) {
    super(
      `Quota exceeded: ${resource} (current=${current}, max=${max})`,
    );
    this.name = "QuotaExceededError";
  }
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}

function maxFor(resource: QuotaResource): number {
  switch (resource) {
    case "passwords":
      return envInt("QUOTA_MAX_PASSWORDS_PER_USER", 10_000);
    case "attachment_bytes":
      return envInt("QUOTA_MAX_ATTACHMENT_BYTES_PER_USER", 1_073_741_824);
    case "share_links":
      return envInt("QUOTA_MAX_SHARE_LINKS_PER_USER", 1_000);
    case "webhooks":
      return envInt("QUOTA_MAX_WEBHOOKS_PER_TENANT", 100);
  }
}

async function currentUsage(
  resource: QuotaResource,
  scope: { userId?: string; tenantId?: string },
): Promise<number> {
  return withBypassRls(
    prisma,
    async (tx) => {
      switch (resource) {
        case "passwords": {
          if (!scope.userId) throw new Error("passwords quota requires userId");
          return tx.passwordEntry.count({
            where: { userId: scope.userId },
          });
        }
        case "attachment_bytes": {
          if (!scope.userId)
            throw new Error("attachment_bytes quota requires userId");
          const result = await tx.attachment.aggregate({
            where: { createdById: scope.userId },
            _sum: { sizeBytes: true },
          });
          return result._sum?.sizeBytes ?? 0;
        }
        case "share_links": {
          if (!scope.userId)
            throw new Error("share_links quota requires userId");
          return tx.passwordShare.count({
            where: { createdById: scope.userId },
          });
        }
        case "webhooks": {
          if (!scope.tenantId)
            throw new Error("webhooks quota requires tenantId");
          // Sum across both webhook types (tenant- and team-scoped).
          const [tenant, team] = await Promise.all([
            tx.tenantWebhook.count({ where: { tenantId: scope.tenantId } }),
            tx.teamWebhook.count({ where: { tenantId: scope.tenantId } }),
          ]);
          return tenant + team;
        }
      }
    },
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );
}

/**
 * Throws QuotaExceededError if (currentUsage + increment) would exceed
 * the configured max. Call BEFORE the actual insert.
 */
export async function assertQuotaAvailable(
  scope: { userId?: string; tenantId?: string },
  resource: QuotaResource,
  increment: number,
): Promise<void> {
  const max = maxFor(resource);
  const current = await currentUsage(resource, scope);
  if (current + increment > max) {
    throw new QuotaExceededError(resource, current, max);
  }
}
