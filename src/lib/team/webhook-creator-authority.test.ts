import { describe, it, expect, vi } from "vitest";
import type { LockedTenantRow } from "./tenant-departure-read";
import { webhookCreatorAuthorized, webhookCreatorVerdicts } from "./webhook-creator-authority";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-02-01T00:00:00Z");
const T2 = new Date("2026-03-01T00:00:00Z");

const active = (role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") => ({
  role,
  deactivatedAt: null,
  admittedAt: null,
  createdAt: T1,
});

const tenantRow = (departedAt: Date | null = null, deactivatedAt: Date | null = null): LockedTenantRow => ({
  hasRow: true,
  role: "MEMBER",
  deactivatedAt,
  departedAt,
});

describe("webhookCreatorAuthorized", () => {
  it("returns legacy when the webhook has no creator, whatever the member", () => {
    expect(webhookCreatorAuthorized(null, null, undefined)).toBe("legacy");
    expect(webhookCreatorAuthorized(null, active("ADMIN"), tenantRow(T2))).toBe("legacy");
  });

  it("returns false when the creator is no longer a member", () => {
    expect(webhookCreatorAuthorized("u1", null, undefined)).toBe(false);
  });

  it("returns false when the creator's membership is deactivated, even as ADMIN", () => {
    expect(
      webhookCreatorAuthorized("u1", { ...active("ADMIN"), deactivatedAt: new Date() }, undefined),
    ).toBe(false);
  });

  it.each(["OWNER", "ADMIN"] as const)("returns true for an active %s", (role) => {
    expect(webhookCreatorAuthorized("u1", active(role), undefined)).toBe(true);
  });

  it.each(["MEMBER", "VIEWER"] as const)(
    "returns false for an active %s (role lacks TEAM_UPDATE)",
    (role) => {
      expect(webhookCreatorAuthorized("u1", active(role), undefined)).toBe(false);
    },
  );

  it("returns false for a leftover: an active admin who left the tenant after joining the team", () => {
    expect(webhookCreatorAuthorized("u1", active("ADMIN"), tenantRow(T2))).toBe(false);
    expect(webhookCreatorAuthorized("u1", active("ADMIN"), tenantRow(null, T2))).toBe(false);
  });

  it("returns false when the departure equals the admission time", () => {
    expect(webhookCreatorAuthorized("u1", active("ADMIN"), tenantRow(T1))).toBe(false);
  });

  it("returns true for a guest creator with no tenant row", () => {
    expect(webhookCreatorAuthorized("u1", active("ADMIN"), undefined)).toBe(true);
    expect(
      webhookCreatorAuthorized("u1", active("ADMIN"), { hasRow: false, role: null, deactivatedAt: null, departedAt: null }),
    ).toBe(true);
  });

  it("returns true for a re-admitted creator: the departure predates admittedAt", () => {
    expect(
      webhookCreatorAuthorized("u1", { ...active("ADMIN"), admittedAt: T2 }, tenantRow(T1)),
    ).toBe(true);
  });

  it("anchors on createdAt when admittedAt is null", () => {
    expect(webhookCreatorAuthorized("u1", { ...active("ADMIN"), createdAt: T2 }, tenantRow(T1))).toBe(true);
    expect(webhookCreatorAuthorized("u1", { ...active("ADMIN"), createdAt: T0 }, tenantRow(T1))).toBe(false);
  });
});

describe("webhookCreatorVerdicts", () => {
  type Member = {
    userId: string;
    role: "ADMIN" | "MEMBER";
    deactivatedAt: Date | null;
    admittedAt: Date | null;
    createdAt: Date;
  };
  const member = (userId: string, role: "ADMIN" | "MEMBER"): Member => ({
    userId,
    role,
    deactivatedAt: null,
    admittedAt: null,
    createdAt: T1,
  });
  const txWith = (
    members: Member[],
    tenantMembers: { userId: string }[] = [],
    departures: { userId: string; departedAt: Date }[] = [],
  ) => {
    const findMany = vi.fn().mockResolvedValue(members);
    const tenantMemberFindMany = vi
      .fn()
      .mockResolvedValue(tenantMembers.map((m) => ({ role: "MEMBER", deactivatedAt: null, ...m })));
    const departureFindMany = vi.fn().mockResolvedValue(departures);
    return {
      tx: {
        teamMember: { findMany },
        tenantMember: { findMany: tenantMemberFindMany },
        tenantMemberDeparture: { findMany: departureFindMany },
      } as never,
      findMany,
      tenantMemberFindMany,
      departureFindMany,
    };
  };

  it("reads each distinct creator once, scoped to the team, and gives a verdict per webhook", async () => {
    const { tx, findMany, tenantMemberFindMany } = txWith([member("admin", "ADMIN"), member("demoted", "MEMBER")]);

    const verdicts = await webhookCreatorVerdicts(tx, "tenant-1", "team-1", [
      { id: "w1", createdById: "admin" },
      { id: "w2", createdById: "admin" },
      { id: "w3", createdById: "demoted" },
      { id: "w4", createdById: "removed" },
      { id: "w5", createdById: null },
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ teamId: "team-1", userId: { in: ["admin", "demoted", "removed"] } });
    expect(tenantMemberFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      userId: { in: ["admin", "demoted", "removed"] },
    });
    expect([...verdicts]).toEqual([["w1", true], ["w2", true], ["w3", false], ["w4", false], ["w5", "legacy"]]);
  });

  it("gives false to a leftover creator and true to a guest and a re-admitted creator", async () => {
    const { tx } = txWith(
      [
        member("leftover", "ADMIN"),
        member("guest", "ADMIN"),
        { ...member("readmitted", "ADMIN"), admittedAt: T2 },
      ],
      [{ userId: "leftover" }, { userId: "readmitted" }],
      [
        { userId: "leftover", departedAt: T2 },
        { userId: "readmitted", departedAt: T1 },
      ],
    );

    const verdicts = await webhookCreatorVerdicts(tx, "tenant-1", "team-1", [
      { id: "w1", createdById: "leftover" },
      { id: "w2", createdById: "guest" },
      { id: "w3", createdById: "readmitted" },
    ]);

    expect([...verdicts]).toEqual([["w1", false], ["w2", true], ["w3", true]]);
  });

  it("skips every read when every webhook is legacy", async () => {
    const { tx, findMany, tenantMemberFindMany, departureFindMany } = txWith([]);

    const verdicts = await webhookCreatorVerdicts(tx, "tenant-1", "team-1", [{ id: "w1", createdById: null }]);

    expect(findMany).not.toHaveBeenCalled();
    expect(tenantMemberFindMany).not.toHaveBeenCalled();
    expect(departureFindMany).not.toHaveBeenCalled();
    expect(verdicts.get("w1")).toBe("legacy");
  });
});
