import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { appliedTenantAuditFilters, buildTenantAuditWhere, validateTenantAuditTeam } from "./tenant-audit-filter";

const TENANT = "tenant-1";
const TEAM = "team-1";
const fakeTx = (findFirst: unknown) =>
  ({ team: { findFirst } }) as unknown as Prisma.TransactionClient;
const USER = "123e4567-e89b-42d3-a456-426614174000";

describe("buildTenantAuditWhere", () => {
  it("defaults to tenant-bound rows of both scopes", () => {
    expect(buildTenantAuditWhere({ tenantId: TENANT, scope: null, teamId: null })).toEqual({
      tenantId: TENANT,
      scope: { in: ["TENANT", "TEAM"] },
    });
  });

  it("narrows to TENANT scope and ignores teamId", () => {
    expect(buildTenantAuditWhere({ tenantId: TENANT, scope: "TENANT", teamId: TEAM })).toEqual({
      tenantId: TENANT,
      scope: "TENANT",
    });
  });

  it("narrows to one team under TEAM scope and under the default scope", () => {
    expect(buildTenantAuditWhere({ tenantId: TENANT, scope: "TEAM", teamId: TEAM })).toEqual({
      tenantId: TENANT,
      scope: "TEAM",
      teamId: TEAM,
    });
    expect(buildTenantAuditWhere({ tenantId: TENANT, scope: null, teamId: TEAM })).toEqual({
      tenantId: TENANT,
      scope: { in: ["TENANT", "TEAM"] },
      teamId: TEAM,
    });
  });

  it("treats an unknown scope as the default", () => {
    expect(buildTenantAuditWhere({ tenantId: TENANT, scope: "PERSONAL", teamId: null }).scope).toEqual({
      in: ["TENANT", "TEAM"],
    });
  });

  it("adds the actor user and actor type when given, and omits them otherwise", () => {
    const withBoth = buildTenantAuditWhere({
      tenantId: TENANT,
      scope: null,
      teamId: null,
      actorType: "HUMAN",
      userId: USER,
    });
    expect(withBoth).toMatchObject({ userId: USER, actorType: "HUMAN", tenantId: TENANT });

    const without = buildTenantAuditWhere({ tenantId: TENANT, scope: null, teamId: null });
    expect(without).not.toHaveProperty("userId");
    expect(without).not.toHaveProperty("actorType");
  });
});

describe("appliedTenantAuditFilters", () => {
  it("drops an unknown scope and a team under TENANT scope", () => {
    expect(appliedTenantAuditFilters("BOGUS", null)).toEqual({});
    expect(appliedTenantAuditFilters("TENANT", "team-1")).toEqual({ scope: "TENANT" });
  });

  it("keeps a team under TEAM scope and under the default scope", () => {
    expect(appliedTenantAuditFilters("TEAM", "team-1")).toEqual({ scope: "TEAM", teamId: "team-1" });
    expect(appliedTenantAuditFilters(null, "team-1")).toEqual({ teamId: "team-1" });
  });
});

describe("validateTenantAuditTeam", () => {
  it("is true without a team and does not query", async () => {
    const findFirst = vi.fn();
    expect(await validateTenantAuditTeam(fakeTx(findFirst), TENANT, null)).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("is true when the team is in the tenant, queried with the tenant id", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: TEAM });
    expect(await validateTenantAuditTeam(fakeTx(findFirst), TENANT, TEAM)).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: TEAM, tenantId: TENANT },
      select: { id: true },
    });
  });

  it("is false when no such team exists in the tenant", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    expect(await validateTenantAuditTeam(fakeTx(findFirst), TENANT, TEAM)).toBe(false);
  });
});
