import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock prisma before importing the module under test
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamPolicy: {
      findUnique: vi.fn(),
    },
    teamMember: {
      findMany: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

// withTeamTenantRls just invokes the callback
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: vi.fn((_teamId: string, fn: () => unknown) => fn()),
  resolveTeamTenantId: vi.fn().mockResolvedValue(null),
}));

// withBypassRls just invokes the callback
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  BYPASS_PURPOSE: { AUTH_FLOW: "auth_flow", CROSS_TENANT_LOOKUP: "cross_tenant_lookup" },
}));

// T3.5: mocks for checkTeamAccessRestriction sentinel fallback tests
const { mockLogAudit } = vi.hoisted(() => ({ mockLogAudit: vi.fn() }));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/ip-access", () => ({
  isIpAllowed: vi.fn().mockReturnValue(false),
  extractClientIp: vi.fn().mockReturnValue("5.6.7.8"),
}));

import { prisma } from "@/lib/prisma";
import {
  getTeamPolicy,
  assertPolicyAllowsExport,
  assertPolicyAllowsSharing,
  assertPolicySharePassword,
  checkTeamAccessRestriction,
  PolicyViolationError,
  type TeamPolicyData,
} from "./team-policy";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";

const mockFindUnique = prisma.teamPolicy.findUnique as ReturnType<typeof vi.fn>;

const fullPolicy: TeamPolicyData & { teamId: string } = {
  teamId: "team-1",
  minPasswordLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSymbols: false,
  maxSessionDurationMinutes: 60,
  sessionIdleTimeoutMinutes: null,
  sessionAbsoluteTimeoutMinutes: null,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

beforeEach(() => {
  mockFindUnique.mockReset();
});

describe("getTeamPolicy", () => {
  it("returns default policy when no DB record exists", async () => {
    mockFindUnique.mockResolvedValue(null);
    const policy = await getTeamPolicy("team-1");
    expect(policy).toEqual({
      minPasswordLength: 0,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
      maxSessionDurationMinutes: null,
      sessionIdleTimeoutMinutes: null,
      sessionAbsoluteTimeoutMinutes: null,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
      requireSharePassword: false,
      passwordHistoryCount: 0,
      inheritTenantCidrs: true,
      teamAllowedCidrs: [],
    });
  });

  it("returns mapped policy when a DB record exists", async () => {
    mockFindUnique.mockResolvedValue(fullPolicy);
    const policy = await getTeamPolicy("team-1");
    expect(policy.minPasswordLength).toBe(12);
    expect(policy.requireUppercase).toBe(true);
    expect(policy.maxSessionDurationMinutes).toBe(60);
    expect(policy.allowExport).toBe(true);
  });

  it("returns a new object (not the same reference as DEFAULT_POLICY)", async () => {
    mockFindUnique.mockResolvedValue(null);
    const p1 = await getTeamPolicy("team-1");
    const p2 = await getTeamPolicy("team-1");
    expect(p1).not.toBe(p2);
  });
});

describe("assertPolicyAllowsExport", () => {
  it("resolves when allowExport is true", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, allowExport: true });
    await expect(assertPolicyAllowsExport("team-1")).resolves.toBeUndefined();
  });

  it("throws PolicyViolationError when allowExport is false", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, allowExport: false });
    await expect(assertPolicyAllowsExport("team-1")).rejects.toThrow(PolicyViolationError);
    await expect(assertPolicyAllowsExport("team-1")).rejects.toThrow("Export is disabled by team policy");
  });

  it("resolves with default policy (allowExport defaults to true)", async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(assertPolicyAllowsExport("team-1")).resolves.toBeUndefined();
  });
});

describe("assertPolicyAllowsSharing", () => {
  it("resolves when allowSharing is true", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, allowSharing: true });
    await expect(assertPolicyAllowsSharing("team-1")).resolves.toBeUndefined();
  });

  it("throws PolicyViolationError when allowSharing is false", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, allowSharing: false });
    await expect(assertPolicyAllowsSharing("team-1")).rejects.toThrow(PolicyViolationError);
    await expect(assertPolicyAllowsSharing("team-1")).rejects.toThrow("Sharing is disabled by team policy");
  });
});

describe("assertPolicySharePassword", () => {
  it("resolves when requireSharePassword is false regardless of requirePassword arg", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, requireSharePassword: false });
    await expect(assertPolicySharePassword("team-1", false)).resolves.toBeUndefined();
    await expect(assertPolicySharePassword("team-1", undefined)).resolves.toBeUndefined();
  });

  it("resolves when requireSharePassword is true and requirePassword is true", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, requireSharePassword: true });
    await expect(assertPolicySharePassword("team-1", true)).resolves.toBeUndefined();
  });

  it("throws when requireSharePassword is true and requirePassword is false", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, requireSharePassword: true });
    await expect(assertPolicySharePassword("team-1", false)).rejects.toThrow(PolicyViolationError);
    await expect(assertPolicySharePassword("team-1", false)).rejects.toThrow("Share password is required by team policy");
  });

  it("throws when requireSharePassword is true and requirePassword is undefined", async () => {
    mockFindUnique.mockResolvedValue({ ...fullPolicy, requireSharePassword: true });
    await expect(assertPolicySharePassword("team-1", undefined)).rejects.toThrow(PolicyViolationError);
  });
});

// getStrictestSessionDuration was removed in the unify-session-timeout-policy plan.
// Its replacement (resolveEffectiveSessionTimeouts) is covered by src/lib/session-timeout.test.ts.

describe("PolicyViolationError", () => {
  it("is an instance of Error", () => {
    const err = new PolicyViolationError("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name PolicyViolationError", () => {
    const err = new PolicyViolationError("test");
    expect(err.name).toBe("PolicyViolationError");
  });

  it("carries the provided message", () => {
    const err = new PolicyViolationError("Export is disabled by team policy");
    expect(err.message).toBe("Export is disabled by team policy");
  });
});

// T3.5: checkTeamAccessRestriction — sentinel fallback for logAuditAsync
describe("checkTeamAccessRestriction — sentinel fallback", () => {
  const restrictivePolicy: TeamPolicyData = {
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
    inheritTenantCidrs: false,
    teamAllowedCidrs: ["192.168.0.0/24"], // non-empty: restriction active
  };

  beforeEach(() => {
    mockLogAudit.mockReset();
  });

  it("uses ANONYMOUS_ACTOR_ID with ANONYMOUS actorType when userId is undefined and IP is blocked", async () => {
    await expect(
      checkTeamAccessRestriction("team-1", "5.6.7.8", undefined, restrictivePolicy),
    ).rejects.toThrow(/Access denied/);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ANONYMOUS_ACTOR_ID,
        actorType: "ANONYMOUS",
        teamId: "team-1",
      }),
    );
  });

  it("uses provided userId with HUMAN actorType when userId is set and IP is blocked", async () => {
    await expect(
      checkTeamAccessRestriction("team-1", "5.6.7.8", "user-xyz", restrictivePolicy),
    ).rejects.toThrow(/Access denied/);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-xyz",
        actorType: "HUMAN",
        teamId: "team-1",
      }),
    );
  });
});
