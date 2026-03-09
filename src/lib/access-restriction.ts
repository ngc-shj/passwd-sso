/**
 * Per-tenant network access restriction.
 *
 * Checks client IP against tenant's allowed CIDRs and/or Tailscale tailnet.
 * Uses OR logic: if CIDR matches OR Tailscale verifies, access is allowed.
 * No restrictions configured = all access allowed (default).
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { isIpAllowed, extractClientIp } from "@/lib/ip-access";
import { verifyTailscalePeer } from "@/lib/tailscale-client";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─── Tenant policy cache ─────────────────────────────────────

interface TenantAccessPolicy {
  allowedCidrs: string[];
  tailscaleEnabled: boolean;
  tailscaleTailnet: string | null;
}

const POLICY_CACHE_TTL_MS = 60_000;

interface PolicyCacheEntry {
  policy: TenantAccessPolicy;
  expiresAt: number;
}

const policyCache = new Map<string, PolicyCacheEntry>();

async function getTenantAccessPolicy(
  tenantId: string,
): Promise<TenantAccessPolicy> {
  const cached = policyCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.policy;
  }
  if (cached) policyCache.delete(tenantId);

  const tenant = await withBypassRls(prisma, async () =>
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        allowedCidrs: true,
        tailscaleEnabled: true,
        tailscaleTailnet: true,
      },
    }),
  );

  const policy: TenantAccessPolicy = {
    allowedCidrs: tenant?.allowedCidrs ?? [],
    tailscaleEnabled: tenant?.tailscaleEnabled ?? false,
    tailscaleTailnet: tenant?.tailscaleTailnet ?? null,
  };

  policyCache.set(tenantId, {
    policy,
    expiresAt: Date.now() + POLICY_CACHE_TTL_MS,
  });

  return policy;
}

/**
 * Invalidate the tenant policy cache for a specific tenant.
 * Call this after updating tenant access restriction settings.
 */
export function invalidateTenantPolicyCache(tenantId: string): void {
  policyCache.delete(tenantId);
}

// ─── Access check result ─────────────────────────────────────

export type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ─── Main check function ─────────────────────────────────────

/**
 * Check if a client IP is allowed to access resources for a given tenant.
 *
 * Returns `{ allowed: true }` if:
 * - No restrictions are configured (fast path)
 * - IP matches any of the tenant's allowed CIDRs
 * - Tailscale is enabled and the IP is verified as belonging to the expected tailnet
 *
 * Returns `{ allowed: false, reason }` otherwise.
 */
export async function checkAccessRestriction(
  tenantId: string,
  clientIp: string | null,
): Promise<AccessCheckResult> {
  const policy = await getTenantAccessPolicy(tenantId);

  // Fast path: no restrictions configured
  if (policy.allowedCidrs.length === 0 && !policy.tailscaleEnabled) {
    return { allowed: true };
  }

  // Deny when IP cannot be determined and restrictions are active
  if (!clientIp) {
    return { allowed: false, reason: "Client IP unknown; access restricted" };
  }

  // Check CIDR allowlist
  if (policy.allowedCidrs.length > 0 && isIpAllowed(clientIp, policy.allowedCidrs)) {
    return { allowed: true };
  }

  // Check Tailscale
  if (policy.tailscaleEnabled && policy.tailscaleTailnet) {
    const verified = await verifyTailscalePeer(clientIp, policy.tailscaleTailnet);
    if (verified) {
      return { allowed: true };
    }
  }

  // Denied
  const reasons: string[] = [];
  if (policy.allowedCidrs.length > 0) {
    reasons.push("IP not in allowed CIDRs");
  }
  if (policy.tailscaleEnabled) {
    reasons.push("Tailscale verification failed");
  }

  return { allowed: false, reason: reasons.join("; ") };
}

/**
 * Check access restriction and log denial if blocked.
 * Convenience wrapper that also emits an audit log on denial.
 */
export async function checkAccessRestrictionWithAudit(
  tenantId: string,
  clientIp: string | null,
  userId: string | null,
  req: NextRequest,
): Promise<AccessCheckResult> {
  const result = await checkAccessRestriction(tenantId, clientIp);

  if (!result.allowed) {
    // Fire-and-forget audit log
    logAudit({
      action: AUDIT_ACTION.ACCESS_DENIED,
      scope: AUDIT_SCOPE.TENANT,
      userId: userId ?? "unknown",
      tenantId,
      ip: clientIp,
      userAgent: req.headers.get("user-agent"),
      metadata: {
        clientIp,
        reason: result.reason,
      },
    });
  }

  return result;
}

/**
 * Check if a client IP would be allowed under a hypothetical policy.
 * Used for self-lockout detection in the PATCH endpoint.
 */
export function wouldIpBeAllowed(
  clientIp: string,
  policy: TenantAccessPolicy,
): boolean {
  if (policy.allowedCidrs.length === 0 && !policy.tailscaleEnabled) {
    return true;
  }
  if (policy.allowedCidrs.length > 0 && isIpAllowed(clientIp, policy.allowedCidrs)) {
    return true;
  }
  // For Tailscale, we can't verify synchronously in a hypothetical check.
  // If Tailscale is enabled AND CIDRs don't match, assume the admin knows what they're doing.
  if (policy.tailscaleEnabled) {
    return true;
  }
  return false;
}

// ─── Route handler wrapper ───────────────────────────────────

/**
 * Enforce access restriction for route handlers that use token-based auth
 * (Bearer extension token, API key, SCIM token).
 *
 * Resolves tenant from userId, checks the client IP against the tenant's
 * access policy. Returns a 403 NextResponse if denied, or null if allowed.
 *
 * Usage in route handler:
 *   const denied = await enforceAccessRestriction(req, userId);
 *   if (denied) return denied;
 */
export async function enforceAccessRestriction(
  req: NextRequest,
  userId: string,
  tenantIdOverride?: string,
): Promise<NextResponse | null> {
  const tenantId = tenantIdOverride ?? (await resolveUserTenantId(userId));
  if (!tenantId) return null;

  const clientIp = extractClientIp(req);
  const result = await checkAccessRestriction(tenantId, clientIp);

  if (!result.allowed) {
    logAudit({
      action: AUDIT_ACTION.ACCESS_DENIED,
      scope: AUDIT_SCOPE.TENANT,
      userId,
      tenantId,
      ip: clientIp,
      userAgent: req.headers.get("user-agent"),
      metadata: { clientIp, reason: result.reason },
    });
    return NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 });
  }

  return null;
}

// ─── Testing helpers ─────────────────────────────────────────

/** @internal Clear policy cache (for testing only) */
export function _clearPolicyCache(): void {
  policyCache.clear();
}
