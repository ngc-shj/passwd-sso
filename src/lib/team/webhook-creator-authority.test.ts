import { describe, it, expect, vi } from "vitest";
import { webhookCreatorAuthorized, webhookCreatorVerdicts } from "./webhook-creator-authority";

const active = (role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") => ({
  role,
  deactivatedAt: null,
});

describe("webhookCreatorAuthorized", () => {
  it("returns legacy when the webhook has no creator, whatever the member", () => {
    expect(webhookCreatorAuthorized(null, null)).toBe("legacy");
    expect(webhookCreatorAuthorized(null, active("ADMIN"))).toBe("legacy");
  });

  it("returns false when the creator is no longer a member", () => {
    expect(webhookCreatorAuthorized("u1", null)).toBe(false);
  });

  it("returns false when the creator's membership is deactivated, even as ADMIN", () => {
    expect(
      webhookCreatorAuthorized("u1", { role: "ADMIN", deactivatedAt: new Date() }),
    ).toBe(false);
  });

  it.each(["OWNER", "ADMIN"] as const)("returns true for an active %s", (role) => {
    expect(webhookCreatorAuthorized("u1", active(role))).toBe(true);
  });

  it.each(["MEMBER", "VIEWER"] as const)(
    "returns false for an active %s (role lacks TEAM_UPDATE)",
    (role) => {
      expect(webhookCreatorAuthorized("u1", active(role))).toBe(false);
    },
  );
});

describe("webhookCreatorVerdicts", () => {
  const txWith = (members: { userId: string; role: "ADMIN" | "MEMBER"; deactivatedAt: Date | null }[]) => {
    const findMany = vi.fn().mockResolvedValue(members);
    return { tx: { teamMember: { findMany } } as never, findMany };
  };

  it("reads each distinct creator once, scoped to the team, and gives a verdict per webhook", async () => {
    const { tx, findMany } = txWith([
      { userId: "admin", role: "ADMIN", deactivatedAt: null },
      { userId: "demoted", role: "MEMBER", deactivatedAt: null },
    ]);

    const verdicts = await webhookCreatorVerdicts(tx, "team-1", [
      { id: "w1", createdById: "admin" },
      { id: "w2", createdById: "admin" },
      { id: "w3", createdById: "demoted" },
      { id: "w4", createdById: "removed" },
      { id: "w5", createdById: null },
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ teamId: "team-1", userId: { in: ["admin", "demoted", "removed"] } });
    expect([...verdicts]).toEqual([["w1", true], ["w2", true], ["w3", false], ["w4", false], ["w5", "legacy"]]);
  });

  it("skips the read when every webhook is legacy", async () => {
    const { tx, findMany } = txWith([]);

    const verdicts = await webhookCreatorVerdicts(tx, "team-1", [{ id: "w1", createdById: null }]);

    expect(findMany).not.toHaveBeenCalled();
    expect(verdicts.get("w1")).toBe("legacy");
  });
});
