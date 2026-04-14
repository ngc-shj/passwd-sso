import { prisma } from "@/lib/prisma";
import { withTeamTenantRls, resolveTeamTenantId } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isIpAllowed, extractClientIp } from "@/lib/ip-access";
import { logAuditAsync } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import type { NextRequest } from "next/server";

export interface TeamPolicyData {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  maxSessionDurationMinutes: number | null;
  requireRepromptForAll: boolean;
  allowExport: boolean;
  allowSharing: boolean;
  requireSharePassword: boolean;
  passwordHistoryCount: number;
  inheritTenantCidrs: boolean;
  teamAllowedCidrs: string[];
}

const DEFAULT_POLICY: TeamPolicyData = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  maxSessionDurationMinutes: null,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/**
 * Get the team policy, falling back to defaults if none is set.
 */
export async function getTeamPolicy(teamId: string): Promise<TeamPolicyData> {
  const policy = await withTeamTenantRls(teamId, async () =>
    prisma.teamPolicy.findUnique({ where: { teamId } }),
  );

  if (!policy) return { ...DEFAULT_POLICY };

  return {
    minPasswordLength: policy.minPasswordLength,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireNumbers: policy.requireNumbers,
    requireSymbols: policy.requireSymbols,
    maxSessionDurationMinutes: policy.maxSessionDurationMinutes,
    requireRepromptForAll: policy.requireRepromptForAll,
    allowExport: policy.allowExport,
    allowSharing: policy.allowSharing,
    requireSharePassword: policy.requireSharePassword,
    passwordHistoryCount: policy.passwordHistoryCount,
    inheritTenantCidrs: policy.inheritTenantCidrs,
    teamAllowedCidrs: policy.teamAllowedCidrs,
  };
}

/**
 * Assert that the team policy allows export. Throws if not allowed.
 */
export async function assertPolicyAllowsExport(teamId: string, existingPolicy?: TeamPolicyData): Promise<void> {
  const policy = existingPolicy ?? await getTeamPolicy(teamId);
  if (!policy.allowExport) {
    throw new PolicyViolationError("Export is disabled by team policy");
  }
}

/**
 * Assert that the team policy allows sharing. Throws if not allowed.
 */
export async function assertPolicyAllowsSharing(
  teamId: string,
): Promise<void> {
  const policy = await getTeamPolicy(teamId);
  if (!policy.allowSharing) {
    throw new PolicyViolationError("Sharing is disabled by team policy");
  }
}

/**
 * Assert that the share includes a password when the team policy requires it.
 * Throws if the policy requires a share password but none was requested.
 */
export async function assertPolicySharePassword(
  teamId: string,
  requirePassword: boolean | undefined,
): Promise<void> {
  const policy = await getTeamPolicy(teamId);
  if (policy.requireSharePassword && !requirePassword) {
    throw new PolicyViolationError(
      "Share password is required by team policy",
    );
  }
}

// ─── Session duration enforcement ────────────────────────────

const sessionDurationCache = new Map<string, { value: number | null; expiresAt: number }>();
const SESSION_DURATION_CACHE_TTL_MS = 60_000;

/**
 * Return the strictest (minimum) maxSessionDurationMinutes across all teams
 * the user belongs to. Returns null if no team sets a session duration limit.
 */
export async function getStrictestSessionDuration(userId: string): Promise<number | null> {
  const cached = sessionDurationCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) sessionDurationCache.delete(userId);

  const memberships = await withBypassRls(
    prisma,
    async () =>
      prisma.teamMember.findMany({
        where: { userId },
        select: {
          team: {
            select: {
              policy: { select: { maxSessionDurationMinutes: true } },
            },
          },
        },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  let minimum: number | null = null;
  for (const m of memberships) {
    const duration = m.team.policy?.maxSessionDurationMinutes ?? null;
    if (duration !== null) {
      minimum = minimum === null ? duration : Math.min(minimum, duration);
    }
  }

  sessionDurationCache.set(userId, { value: minimum, expiresAt: Date.now() + SESSION_DURATION_CACHE_TTL_MS });
  return minimum;
}

// ─── Team IP restriction ──────────────────────────────────────

/**
 * Check whether the given client IP is allowed to access the team's resources.
 * Throws PolicyViolationError and emits an ACCESS_DENIED audit log if blocked.
 * An already-fetched policy may be passed to avoid a redundant DB read.
 */
export async function checkTeamAccessRestriction(teamId: string, clientIp: string, userId?: string, existingPolicy?: TeamPolicyData): Promise<void> {
  const policy = existingPolicy ?? await getTeamPolicy(teamId);

  // No restriction configured for this team
  if (policy.teamAllowedCidrs.length === 0 && !policy.inheritTenantCidrs) {
    return;
  }

  const combinedCidrs = [...policy.teamAllowedCidrs];

  if (policy.inheritTenantCidrs) {
    const tenantId = await resolveTeamTenantId(teamId);
    if (tenantId) {
      const tenant = await withBypassRls(
        prisma,
        async () =>
          prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { allowedCidrs: true },
          }),
        BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
      );
      if (tenant?.allowedCidrs) {
        combinedCidrs.push(...tenant.allowedCidrs);
      }
    }
  }

  if (combinedCidrs.length === 0) {
    // inheritTenantCidrs is true but tenant has no CIDRs configured — no restriction
    return;
  }

  if (isIpAllowed(clientIp, combinedCidrs)) {
    return;
  }

  await logAuditAsync({
    action: AUDIT_ACTION.ACCESS_DENIED,
    scope: AUDIT_SCOPE.TEAM,
    userId: userId ?? null,
    teamId,
    ip: clientIp,
    metadata: { clientIp, reason: "IP not in team allowed CIDRs" },
  });

  throw new PolicyViolationError("Access denied: IP not in team allowed CIDRs");
}

/**
 * Convenience wrapper: extract client IP from request and check team access restriction.
 */
export async function withTeamIpRestriction(teamId: string, request: NextRequest, userId?: string): Promise<void> {
  const clientIp = extractClientIp(request);
  // Fetch the policy once; pass it through to avoid a second DB call inside checkTeamAccessRestriction.
  const policy = await getTeamPolicy(teamId);
  if (!clientIp) {
    // Cannot determine IP — only block if there are explicit team CIDRs configured.
    // For inheritTenantCidrs, defer to checkTeamAccessRestriction which resolves
    // actual tenant CIDRs; pass empty string so it can determine whether any CIDRs exist.
    if (policy.teamAllowedCidrs.length > 0) {
      throw new PolicyViolationError("Access denied: client IP unknown; access restricted");
    }
    if (!policy.inheritTenantCidrs) {
      return;
    }
    // inheritTenantCidrs=true: let checkTeamAccessRestriction resolve tenant CIDRs.
    // Pass empty string IP so isIpAllowed will return false only if CIDRs actually exist.
    await checkTeamAccessRestriction(teamId, "", userId, policy);
    return;
  }
  await checkTeamAccessRestriction(teamId, clientIp, userId, policy);
}

