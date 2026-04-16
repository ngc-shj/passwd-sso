/**
 * Per-tenant network access restriction.
 *
 * Checks client IP against tenant's allowed CIDRs and/or Tailscale tailnet.
 * Uses OR logic: if CIDR matches OR Tailscale verifies, access is allowed.
 * No restrictions configured = all access allowed (default).
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isIpAllowed, isTailscaleIp, extractClientIp } from "@/lib/ip-access";
import { verifyTailscalePeer } from "@/lib/tailscale-client";
import { logAuditAsync } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit";
import type { ActorType } from "@prisma/client";
import { resolveAuditUserId, SENTINEL_ACTOR_IDS } from "@/lib/constants/app";
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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

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

  // Check Tailscale: allow if client IP is in CGNAT range (100.64.0.0/10).
  // This covers both direct Tailscale connections and Tailscale Serve proxied
  // requests (Serve sets X-Forwarded-For with the peer's CGNAT IP, which
  // extractClientIp resolves via rightmost-untrusted).
  //
  // CGNAT is exclusively used by Tailscale and unreachable from the public
  // internet. This check runs in Edge runtime where tailscaled WhoIs (Unix
  // socket) is unavailable. Full tailnet verification happens in
  // enforceAccessRestriction (Node.js runtime route handlers).
  if (policy.tailscaleEnabled && isTailscaleIp(clientIp)) {
    return { allowed: true };
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
    await logAuditAsync({
      action: AUDIT_ACTION.ACCESS_DENIED,
      scope: AUDIT_SCOPE.TENANT,
      userId: resolveAuditUserId(userId, "anonymous"),
      actorType: userId ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.ANONYMOUS,
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
 * When userId is a sentinel (SYSTEM_ACTOR_ID / ANONYMOUS_ACTOR_ID), a
 * tenantIdOverride MUST be supplied — without it the function cannot resolve
 * a tenant and returns 403 fail-closed rather than silently skipping.
 *
 * Usage in route handler:
 *   const denied = await enforceAccessRestriction(req, userId, tenantId, actorType);
 *   if (denied) return denied;
 */
export async function enforceAccessRestriction(
  req: NextRequest,
  userId: string,
  tenantIdOverride?: string,
  actorType?: ActorType,
): Promise<NextResponse | null> {
  // Fail-closed: sentinel actor IDs are never in the users table, so
  // resolveUserTenantId would return null and silently skip all checks.
  if (SENTINEL_ACTOR_IDS.has(userId) && !tenantIdOverride) {
    return NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 });
  }

  const tenantId = tenantIdOverride ?? (await resolveUserTenantId(userId));
  if (!tenantId) return null;

  const clientIp = extractClientIp(req);
  const result = await checkAccessRestriction(tenantId, clientIp);

  if (!result.allowed) {
    await logAuditAsync({
      action: AUDIT_ACTION.ACCESS_DENIED,
      scope: AUDIT_SCOPE.TENANT,
      userId,
      ...(actorType ? { actorType } : {}),
      tenantId,
      ip: clientIp,
      userAgent: req.headers.get("user-agent"),
      metadata: { clientIp, reason: result.reason },
    });
    return NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 });
  }

  // Additional Tailscale tailnet verification via WhoIs (Node.js runtime only).
  // checkAccessRestriction (Edge-compatible) allows any CGNAT IP. Here we verify
  // the exact tailnet to prevent access from a different Tailscale account.
  const policy = await getTenantAccessPolicy(tenantId);
  if (policy.tailscaleEnabled && policy.tailscaleTailnet && clientIp && isTailscaleIp(clientIp)) {
    const verified = await verifyTailscalePeer(clientIp, policy.tailscaleTailnet);
    if (!verified) {
      await logAuditAsync({
        action: AUDIT_ACTION.ACCESS_DENIED,
        scope: AUDIT_SCOPE.TENANT,
        userId,
        ...(actorType ? { actorType } : {}),
        tenantId,
        ip: clientIp,
        userAgent: req.headers.get("user-agent"),
        metadata: { clientIp, reason: "Tailscale tailnet mismatch" },
      });
      return NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 });
    }
  }

  return null;
}

// ─── Testing helpers ─────────────────────────────────────────

/** @internal Clear policy cache (for testing only) */
export function _clearPolicyCache(): void {
  policyCache.clear();
}
