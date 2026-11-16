import { describe, it, expect, vi } from "vitest";
import { creatorAuthorizedOf, creatorVerdicts, holdsTenantAuthority } from "./creator-authority";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-02-01T00:00:00Z");
const T2 = new Date("2026-03-01T00:00:00Z");

type TenantRoleName = "OWNER" | "ADMIN" | "MEMBER";
type Member = { userId: string; role: TenantRoleName; deactivatedAt: Date | null };

const member = (userId: string, role: TenantRoleName, deactivatedAt: Date | null = null): Member => ({
  userId,
  role,
  deactivatedAt,
});

const txWith = (members: Member[], departures: { userId: string; departedAt: Date }[] = []) => {
  const memberFindMany = vi.fn().mockResolvedValue(members);
  const departureFindMany = vi.fn().mockResolvedValue(departures);
  return {
    tx: {
      tenantMember: { findMany: memberFindMany },
      tenantMemberDeparture: { findMany: departureFindMany },
    } as never,
    memberFindMany,
    departureFindMany,
  };
};

const verdictFor = async (
  members: Member[],
  departures: { userId: string; departedAt: Date }[],
  createdAt: Date = T1,
) => {
  const { tx } = txWith(members, departures);
  const verdicts = await creatorVerdicts(tx, "tenant-1", [{ id: "w1", createdById: "u1", createdAt }], TENANT_PERMISSION.WEBHOOK_MANAGE);
  return verdicts.get("w1");
};

describe("creatorVerdicts", () => {
  it("returns legacy for a NULL creator without reading", async () => {
    const { tx, memberFindMany, departureFindMany } = txWith([]);
    const verdicts = await creatorVerdicts(tx, "tenant-1", [{ id: "w1", createdById: null, createdAt: T1 }], TENANT_PERMISSION.WEBHOOK_MANAGE);
    expect(verdicts.get("w1")).toBe("legacy");
    expect(memberFindMany).not.toHaveBeenCalled();
    expect(departureFindMany).not.toHaveBeenCalled();
  });

  it.each(["OWNER", "ADMIN"] as const)("returns true for an active %s", async (role) => {
    expect(await verdictFor([member("u1", role)], [])).toBe(true);
  });

  it("returns false for a deactivated admin", async () => {
    expect(await verdictFor([member("u1", "ADMIN", T0)], [])).toBe(false);
  });

  it("returns false for a demoted creator whose role lacks the permission", async () => {
    expect(await verdictFor([member("u1", "MEMBER")], [])).toBe(false);
  });

  it("returns false when the creator has no tenant row", async () => {
    expect(await verdictFor([], [])).toBe(false);
  });

  it("returns false when a departure record is after the row's creation", async () => {
    expect(await verdictFor([member("u1", "ADMIN")], [{ userId: "u1", departedAt: T2 }])).toBe(false);
  });

  it("returns false when a departure record equals the row's creation time", async () => {
    expect(await verdictFor([member("u1", "ADMIN")], [{ userId: "u1", departedAt: T1 }])).toBe(false);
  });

  it("returns true when the departure record predates the row's creation", async () => {
    expect(await verdictFor([member("u1", "ADMIN")], [{ userId: "u1", departedAt: T0 }])).toBe(true);
  });

  it("reads each distinct creator once, scoped to the tenant, and answers per row", async () => {
    const { tx, memberFindMany, departureFindMany } = txWith([member("admin", "ADMIN"), member("demoted", "MEMBER")]);

    const verdicts = await creatorVerdicts(
      tx,
      "tenant-1",
      [
        { id: "w1", createdById: "admin", createdAt: T1 },
        { id: "w2", createdById: "admin", createdAt: T2 },
        { id: "w3", createdById: "demoted", createdAt: T1 },
        { id: "w4", createdById: "removed", createdAt: T1 },
        { id: "w5", createdById: null, createdAt: T1 },
      ],
      TENANT_PERMISSION.WEBHOOK_MANAGE,
    );

    expect(memberFindMany).toHaveBeenCalledTimes(1);
    expect(departureFindMany).toHaveBeenCalledTimes(1);
    expect(memberFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      userId: { in: ["admin", "demoted", "removed"] },
    });
    expect([...verdicts]).toEqual([["w1", true], ["w2", true], ["w3", false], ["w4", false], ["w5", "legacy"]]);
  });
});

describe("holdsTenantAuthority", () => {
  const row = (over: Partial<{ hasRow: boolean; role: "OWNER" | "ADMIN" | "MEMBER" | null; deactivatedAt: Date | null }> = {}) => ({
    hasRow: true,
    role: "ADMIN" as const,
    deactivatedAt: null,
    departedAt: null,
    ...over,
  });

  it("is false for a missing row", () => {
    expect(holdsTenantAuthority(undefined, null)).toBe(false);
  });

  it("is false for a user without a tenant row", () => {
    expect(holdsTenantAuthority(row({ hasRow: false, role: null }), null)).toBe(false);
  });

  it("is false for a deactivated row", () => {
    expect(holdsTenantAuthority(row({ deactivatedAt: T0 }), null)).toBe(false);
  });

  it("is false for a null role", () => {
    expect(holdsTenantAuthority(row({ role: null }), null)).toBe(false);
  });

  it("is true for an active row when no permission is required", () => {
    expect(holdsTenantAuthority(row({ role: "MEMBER" }), null)).toBe(true);
  });

  it("is false when the role lacks the permission", () => {
    expect(holdsTenantAuthority(row({ role: "MEMBER" }), TENANT_PERMISSION.WEBHOOK_MANAGE)).toBe(false);
  });

  it("is true when the role holds the permission", () => {
    expect(holdsTenantAuthority(row({ role: "ADMIN" }), TENANT_PERMISSION.WEBHOOK_MANAGE)).toBe(true);
  });
});

describe("creatorAuthorizedOf", () => {
  it.each([
    ["legacy", null],
    [true, true],
    [false, false],
    [undefined, false],
  ] as const)("answers %s as %s", (verdict, expected) => {
    expect(creatorAuthorizedOf(verdict)).toBe(expected);
  });
});
