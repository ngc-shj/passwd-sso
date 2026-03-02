import { prisma } from "@/lib/prisma";
import { withTeamTenantRls } from "@/lib/tenant-context";

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
};

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
  };
}

/**
 * Assert that the team policy allows export. Throws if not allowed.
 */
export async function assertPolicyAllowsExport(teamId: string): Promise<void> {
  const policy = await getTeamPolicy(teamId);
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

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}
