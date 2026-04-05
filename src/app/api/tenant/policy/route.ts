import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { createRateLimiter } from "@/lib/rate-limit";
import { TAILNET_NAME_MAX_LENGTH } from "@/lib/validations";
import { withRequestLog } from "@/lib/with-request-log";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isValidCidr, extractClientIp } from "@/lib/ip-access";
import { invalidateTenantPolicyCache, wouldIpBeAllowed } from "@/lib/access-restriction";
import { pinLengthSchema, MAX_CIDRS } from "@/lib/validations/common";
import {
  MAX_CONCURRENT_SESSIONS_MIN,
  MAX_CONCURRENT_SESSIONS_MAX,
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
  VAULT_AUTO_LOCK_MIN,
  VAULT_AUTO_LOCK_MAX,
  IP_ADDRESS_MAX_LENGTH,
} from "@/lib/validations/common.server";

const policyLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/tenant/policy — read tenant session policy
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  try {
    await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const user = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenant: { select: {
        maxConcurrentSessions: true,
        sessionIdleTimeoutMinutes: true,
        vaultAutoLockMinutes: true,
        allowedCidrs: true,
        tailscaleEnabled: true,
        tailscaleTailnet: true,
        requireMinPinLength: true,
      } } },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  return NextResponse.json({
    maxConcurrentSessions: user?.tenant?.maxConcurrentSessions ?? null,
    sessionIdleTimeoutMinutes: user?.tenant?.sessionIdleTimeoutMinutes ?? null,
    vaultAutoLockMinutes: user?.tenant?.vaultAutoLockMinutes ?? null,
    allowedCidrs: user?.tenant?.allowedCidrs ?? [],
    tailscaleEnabled: user?.tenant?.tailscaleEnabled ?? false,
    tailscaleTailnet: user?.tenant?.tailscaleTailnet ?? null,
    requireMinPinLength: user?.tenant?.requireMinPinLength ?? null,
  });
}

// PATCH /api/tenant/policy — update tenant session policy
async function handlePATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await policyLimiter.check(`rl:tenant_policy:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  let membership;
  try {
    membership = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  const { maxConcurrentSessions, sessionIdleTimeoutMinutes, vaultAutoLockMinutes, allowedCidrs, tailscaleEnabled, tailscaleTailnet, requireMinPinLength, confirmLockout } = body;

  // Validate maxConcurrentSessions: null (unlimited) or positive integer
  if (maxConcurrentSessions !== null && maxConcurrentSessions !== undefined) {
    if (
      typeof maxConcurrentSessions !== "number" ||
      !Number.isInteger(maxConcurrentSessions) ||
      maxConcurrentSessions < MAX_CONCURRENT_SESSIONS_MIN ||
      maxConcurrentSessions > MAX_CONCURRENT_SESSIONS_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate vaultAutoLockMinutes: null (default 15min) or positive integer up to 24h
  if (vaultAutoLockMinutes !== null && vaultAutoLockMinutes !== undefined) {
    if (
      typeof vaultAutoLockMinutes !== "number" ||
      !Number.isInteger(vaultAutoLockMinutes) ||
      vaultAutoLockMinutes < VAULT_AUTO_LOCK_MIN ||
      vaultAutoLockMinutes > VAULT_AUTO_LOCK_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate sessionIdleTimeoutMinutes: null (disabled) or positive integer up to 24h
  if (sessionIdleTimeoutMinutes !== null && sessionIdleTimeoutMinutes !== undefined) {
    if (
      typeof sessionIdleTimeoutMinutes !== "number" ||
      !Number.isInteger(sessionIdleTimeoutMinutes) ||
      sessionIdleTimeoutMinutes < SESSION_IDLE_TIMEOUT_MIN ||
      sessionIdleTimeoutMinutes > SESSION_IDLE_TIMEOUT_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate allowedCidrs: null/[] or array of valid CIDR strings, max 50
  if (allowedCidrs !== null && allowedCidrs !== undefined) {
    if (!Array.isArray(allowedCidrs)) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
    if (allowedCidrs.length > MAX_CIDRS) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: `Maximum ${MAX_CIDRS} CIDRs allowed` });
    }
    for (const cidr of allowedCidrs) {
      if (typeof cidr !== "string" || !isValidCidr(cidr)) {
        const truncated = typeof cidr === "string" ? cidr.slice(0, IP_ADDRESS_MAX_LENGTH) : String(cidr).slice(0, IP_ADDRESS_MAX_LENGTH);
        return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: `Invalid CIDR: ${truncated}` });
      }
    }
  }

  // Validate tailscaleEnabled: boolean
  if (tailscaleEnabled !== undefined && typeof tailscaleEnabled !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate tailscaleTailnet: required when tailscaleEnabled is true
  if (tailscaleEnabled === true) {
    if (tailscaleTailnet === undefined) {
      // Not in request — check if DB already has a value
      const existing = await withBypassRls(prisma, async () =>
        prisma.tenant.findUnique({
          where: { id: membership.tenantId },
          select: { tailscaleTailnet: true },
        }),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
      if (!existing?.tailscaleTailnet) {
        return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet is required when tailscaleEnabled is true" });
      }
    } else if (!tailscaleTailnet || typeof tailscaleTailnet !== "string" || tailscaleTailnet.trim().length === 0) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet is required when tailscaleEnabled is true" });
    }
  }
  if (tailscaleTailnet !== null && tailscaleTailnet !== undefined) {
    if (typeof tailscaleTailnet !== "string" || tailscaleTailnet.length > TAILNET_NAME_MAX_LENGTH) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
    // DNS hostname characters only: alphanumeric, hyphens, dots
    if (tailscaleTailnet.length > 0 && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(tailscaleTailnet)) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet must contain only valid DNS hostname characters (a-z, 0-9, hyphens, dots)" });
    }
  }

  // Validate requireMinPinLength: null (disabled) or integer within CTAP2 bounds
  if (requireMinPinLength !== null && requireMinPinLength !== undefined) {
    if (!pinLengthSchema.safeParse(requireMinPinLength).success) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Self-lockout detection: check if the requester's IP would be allowed under the new policy
  const newAllowedCidrs = allowedCidrs !== undefined ? (allowedCidrs ?? []) : undefined;
  const newTailscaleEnabled = tailscaleEnabled !== undefined ? tailscaleEnabled : undefined;
  if ((newAllowedCidrs !== undefined || newTailscaleEnabled !== undefined) && !confirmLockout) {
    // Build hypothetical policy
    const currentTenant = await withBypassRls(prisma, async () =>
      prisma.tenant.findUnique({
        where: { id: membership.tenantId },
        select: { allowedCidrs: true, tailscaleEnabled: true, tailscaleTailnet: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    const hypothetical = {
      allowedCidrs: newAllowedCidrs ?? currentTenant?.allowedCidrs ?? [],
      tailscaleEnabled: newTailscaleEnabled ?? currentTenant?.tailscaleEnabled ?? false,
      tailscaleTailnet: (tailscaleTailnet !== undefined ? tailscaleTailnet : currentTenant?.tailscaleTailnet) ?? null,
    };
    const clientIp = extractClientIp(req);
    const hasRestrictions = hypothetical.allowedCidrs.length > 0 || hypothetical.tailscaleEnabled;
    if (hasRestrictions && (!clientIp || !wouldIpBeAllowed(clientIp, hypothetical))) {
      const message = clientIp
        ? "Your current IP would be blocked by this policy. Set confirmLockout: true to proceed."
        : "Your IP could not be determined; you may be locked out by this policy. Set confirmLockout: true to proceed.";
      return NextResponse.json(
        { error: API_ERROR.SELF_LOCKOUT, message },
        { status: 409 },
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (maxConcurrentSessions !== undefined) {
    updateData.maxConcurrentSessions = maxConcurrentSessions ?? null;
  }
  if (sessionIdleTimeoutMinutes !== undefined) {
    updateData.sessionIdleTimeoutMinutes = sessionIdleTimeoutMinutes ?? null;
  }
  if (vaultAutoLockMinutes !== undefined) {
    updateData.vaultAutoLockMinutes = vaultAutoLockMinutes ?? null;
  }
  if (allowedCidrs !== undefined) {
    updateData.allowedCidrs = allowedCidrs ?? [];
  }
  if (tailscaleEnabled !== undefined) {
    updateData.tailscaleEnabled = tailscaleEnabled;
  }
  if (tailscaleTailnet !== undefined) {
    updateData.tailscaleTailnet = tailscaleTailnet ?? null;
  }
  if (requireMinPinLength !== undefined) {
    updateData.requireMinPinLength = requireMinPinLength ?? null;
  }

  const updated = await withBypassRls(prisma, async () =>
    prisma.tenant.update({
      where: { id: membership.tenantId },
      data: updateData,
      select: {
        maxConcurrentSessions: true,
        sessionIdleTimeoutMinutes: true,
        vaultAutoLockMinutes: true,
        allowedCidrs: true,
        tailscaleEnabled: true,
        tailscaleTailnet: true,
        requireMinPinLength: true,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Bust the tenant policy cache so access restriction picks up new values immediately
  invalidateTenantPolicyCache(membership.tenantId);

  const meta = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.POLICY_UPDATE,
    userId: session.user.id,
    tenantId: membership.tenantId,
    metadata: {
      maxConcurrentSessions: updated.maxConcurrentSessions,
      sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
      vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
      allowedCidrs: updated.allowedCidrs,
      tailscaleEnabled: updated.tailscaleEnabled,
      tailscaleTailnet: updated.tailscaleTailnet,
      requireMinPinLength: updated.requireMinPinLength,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({
    maxConcurrentSessions: updated.maxConcurrentSessions,
    sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
    vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
    allowedCidrs: updated.allowedCidrs,
    tailscaleEnabled: updated.tailscaleEnabled,
    tailscaleTailnet: updated.tailscaleTailnet,
    requireMinPinLength: updated.requireMinPinLength,
  });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
