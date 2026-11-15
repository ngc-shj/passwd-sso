import { describe, it, expect, vi } from "vitest";
import type { TeamRole } from "@prisma/client";
import {
  heldTeamKeyVersions,
  isRekeyerHolder,
  itemKeyIdsMatch,
  itemKeyIvReused,
  nextItemKeyVersion,
  normalizeTeamKeyVersion,
  teamKeyVersionHolders,
  inactiveTeamKeyVersionHolderCount,
} from "./team-item-key";
import * as resolution from "./team-key-resolution";

const ID_A = "11111111-1111-4111-8111-111111111111";

describe("shared ItemKey helpers", () => {
  it("re-exports the single client-safe definitions", () => {
    expect(itemKeyIdsMatch).toBe(resolution.itemKeyIdsMatch);
    expect(normalizeTeamKeyVersion).toBe(resolution.normalizeTeamKeyVersion);
  });
});

describe("itemKeyIvReused", () => {
  const IV_LOCKED = "a".repeat(24);
  const IV_HISTORY = "b".repeat(24);
  const IV_FRESH = "c".repeat(24);
  const tx = (ivs: (string | null)[]) => ({
    teamPasswordEntryHistory: { findMany: vi.fn().mockResolvedValue(ivs.map((itemKeyIv) => ({ itemKeyIv }))) },
  });

  it("is false for an IV neither the entry nor its history used", async () => {
    const client = tx([IV_HISTORY, null]);
    expect(await itemKeyIvReused(client as never, ID_A, IV_LOCKED, IV_FRESH)).toBe(false);
    expect(client.teamPasswordEntryHistory.findMany).toHaveBeenCalledWith({
      where: { entryId: ID_A },
      select: { itemKeyIv: true },
    });
  });

  it("is true for the locked entry's IV, in any hex case", async () => {
    expect(await itemKeyIvReused(tx([]) as never, ID_A, IV_LOCKED, IV_LOCKED.toUpperCase())).toBe(true);
  });

  it("is true for a history row's IV, in any hex case", async () => {
    expect(await itemKeyIvReused(tx([IV_HISTORY.toUpperCase()]) as never, ID_A, null, IV_HISTORY)).toBe(true);
  });
});

const T1 = new Date("2026-02-01T00:00:00Z");
const T2 = new Date("2026-03-01T00:00:00Z");

type FakeMember = {
  userId: string;
  role?: TeamRole;
  deactivatedAt?: Date | null;
  admittedAt?: Date | null;
  createdAt?: Date;
};

/** A tx with the team's keys and members and the tenant's rows and departures. */
function fakeTx(
  keys: { userId: string }[],
  members: FakeMember[],
  departures: { userId: string; departedAt: Date }[] = [],
  tenantMembers: { userId: string; deactivatedAt?: Date | null }[] = [],
) {
  return {
    teamMemberKey: { findMany: vi.fn().mockResolvedValue(keys) },
    teamMember: {
      findMany: vi.fn().mockResolvedValue(
        members.map((m) => ({ role: "MEMBER", deactivatedAt: null, admittedAt: null, createdAt: T1, ...m })),
      ),
    },
    tenantMember: {
      findMany: vi
        .fn()
        .mockResolvedValue(tenantMembers.map((m) => ({ role: "MEMBER", deactivatedAt: null, ...m }))),
    },
    tenantMemberDeparture: { findMany: vi.fn().mockResolvedValue(departures) },
  };
}

describe("teamKeyVersionHolders", () => {
  it("returns the active members holding a key at the version", async () => {
    const tx = fakeTx([{ userId: "u1" }, { userId: "u2" }], [{ userId: "u1", role: "ADMIN" }]);
    const holders = await teamKeyVersionHolders(tx as never, "tenant-1", "team-1", 3);

    expect(holders).toEqual([{ userId: "u1", role: "ADMIN" }]);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", keyVersion: 3 },
      select: { userId: true },
    });
    // Only active memberships count: a departed member's key row does not.
    expect(tx.teamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: { in: ["u1", "u2"] }, deactivatedAt: null },
      select: { userId: true, role: true, admittedAt: true, createdAt: true },
    });
  });

  it("looks up a version below 1 as version 1", async () => {
    const tx = fakeTx([], []);
    await teamKeyVersionHolders(tx as never, "tenant-1", "team-1", 0);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", keyVersion: 1 },
      select: { userId: true },
    });
  });

  it("returns no holder without reading memberships when no key row exists", async () => {
    const tx = fakeTx([], [{ userId: "u1", role: "OWNER" }]);
    expect(await teamKeyVersionHolders(tx as never, "tenant-1", "team-1", 2)).toEqual([]);
    expect(tx.teamMember.findMany).not.toHaveBeenCalled();
  });

  it("excludes a leftover holder: an active member who left the tenant after admission", async () => {
    const tx = fakeTx(
      [{ userId: "leftover" }, { userId: "active" }],
      [{ userId: "leftover", role: "ADMIN" }, { userId: "active", role: "ADMIN" }],
      [{ userId: "leftover", departedAt: T2 }],
      [{ userId: "leftover" }, { userId: "active" }],
    );
    expect(await teamKeyVersionHolders(tx as never, "tenant-1", "team-1", 1)).toEqual([
      { userId: "active", role: "ADMIN" },
    ]);
    expect(tx.tenantMember.findMany.mock.calls[0][0].where.tenantId).toBe("tenant-1");
  });

  it("keeps a guest holder (no tenant row) and a re-admitted holder (departure before admittedAt)", async () => {
    const tx = fakeTx(
      [{ userId: "guest" }, { userId: "readmitted" }],
      [{ userId: "guest" }, { userId: "readmitted", admittedAt: T2 }],
      [{ userId: "readmitted", departedAt: T1 }],
      [{ userId: "readmitted" }],
    );
    const holders = await teamKeyVersionHolders(tx as never, "tenant-1", "team-1", 1);
    expect(holders.map((h) => h.userId)).toEqual(["guest", "readmitted"]);
  });
});

describe("inactiveTeamKeyVersionHolderCount", () => {
  it("counts key holders at the version whose membership is deactivated", async () => {
    const tx = fakeTx(
      [{ userId: "u1" }, { userId: "u2" }],
      [{ userId: "u1", deactivatedAt: T2 }, { userId: "u2" }],
    );
    expect(await inactiveTeamKeyVersionHolderCount(tx as never, "tenant-1", "team-1", 0)).toBe(1);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({ where: { teamId: "team-1", keyVersion: 1 }, select: { userId: true } });
    expect(tx.teamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: { in: ["u1", "u2"] } },
      select: { userId: true, deactivatedAt: true, admittedAt: true, createdAt: true },
    });
  });

  it("counts a leftover holder too, so a leftover-only version still reads as held by someone who could return", async () => {
    const tx = fakeTx(
      [{ userId: "leftover" }],
      [{ userId: "leftover" }],
      [{ userId: "leftover", departedAt: T2 }],
      [{ userId: "leftover" }],
    );
    expect(await inactiveTeamKeyVersionHolderCount(tx as never, "tenant-1", "team-1", 1)).toBe(1);
  });

  it("does not count an active holder, a guest or a re-admitted holder", async () => {
    const tx = fakeTx(
      [{ userId: "active" }, { userId: "guest" }, { userId: "readmitted" }],
      [{ userId: "active" }, { userId: "guest" }, { userId: "readmitted", admittedAt: T2 }],
      [{ userId: "readmitted", departedAt: T1 }],
      [{ userId: "active" }, { userId: "readmitted" }],
    );
    expect(await inactiveTeamKeyVersionHolderCount(tx as never, "tenant-1", "team-1", 1)).toBe(0);
  });

  it("is 0 without reading memberships when no key row exists", async () => {
    const tx = fakeTx([], []);
    expect(await inactiveTeamKeyVersionHolderCount(tx as never, "tenant-1", "team-1", 2)).toBe(0);
    expect(tx.teamMember.findMany).not.toHaveBeenCalled();
  });
});

describe("isRekeyerHolder", () => {
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["MEMBER", false],
    ["VIEWER", false],
  ] as const)("%s → %s", (role, expected) => {
    expect(isRekeyerHolder({ userId: "u1", role })).toBe(expected);
  });
});

describe("heldTeamKeyVersions", () => {
  it("returns the versions the user has a member-key row for, ascending", async () => {
    const tx = { teamMemberKey: { findMany: vi.fn().mockResolvedValue([{ keyVersion: 1 }, { keyVersion: 3 }]) } };
    expect(await heldTeamKeyVersions(tx as never, "team-1", "u1")).toEqual([1, 3]);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: "u1" },
      select: { keyVersion: true },
      orderBy: { keyVersion: "asc" },
    });
  });
});

describe("nextItemKeyVersion", () => {
  it("is the high-water + 1 when the high-water covers the entry's version", () => {
    expect(nextItemKeyVersion(3, 1)).toBe(4);
  });

  it("is the entry's version + 1 when the high-water lags it (a previous-release v1 write left it at 0)", () => {
    expect(nextItemKeyVersion(0, 1)).toBe(2);
  });
});
