import { describe, it, expect, vi } from "vitest";
import type { TeamRole } from "@prisma/client";
import {
  heldTeamKeyVersions,
  isRekeyerHolder,
  itemKeyIdsMatch,
  normalizeTeamKeyVersion,
  teamKeyVersionHolders,
} from "./team-item-key";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("itemKeyIdsMatch", () => {
  it("matches the same id", () => {
    expect(itemKeyIdsMatch(ID_A, ID_A)).toBe(true);
  });

  it("matches the same id regardless of hex case", () => {
    expect(itemKeyIdsMatch(ID_A, ID_A.toUpperCase())).toBe(true);
  });

  it("does not match different ids", () => {
    expect(itemKeyIdsMatch(ID_A, ID_B)).toBe(false);
  });

  it("never matches null against null", () => {
    expect(itemKeyIdsMatch(null, null)).toBe(false);
    expect(itemKeyIdsMatch(undefined, undefined)).toBe(false);
  });

  it("never matches a null on either side", () => {
    expect(itemKeyIdsMatch(null, ID_A)).toBe(false);
    expect(itemKeyIdsMatch(ID_A, null)).toBe(false);
    expect(itemKeyIdsMatch(undefined, ID_A)).toBe(false);
  });
});

describe("normalizeTeamKeyVersion", () => {
  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [7, 7],
  ])("maps %i to %i", (input, expected) => {
    expect(normalizeTeamKeyVersion(input)).toBe(expected);
  });
});

describe("teamKeyVersionHolders", () => {
  function fakeTx(keys: { userId: string }[], members: { userId: string; role: TeamRole }[]) {
    return {
      teamMemberKey: { findMany: vi.fn().mockResolvedValue(keys) },
      teamMember: { findMany: vi.fn().mockResolvedValue(members) },
    };
  }

  it("returns the active members holding a key at the version", async () => {
    const tx = fakeTx([{ userId: "u1" }, { userId: "u2" }], [{ userId: "u1", role: "ADMIN" }]);
    const holders = await teamKeyVersionHolders(tx as never, "team-1", 3);

    expect(holders).toEqual([{ userId: "u1", role: "ADMIN" }]);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", keyVersion: 3 },
      select: { userId: true },
    });
    // Only active memberships count: a departed member's key row does not.
    expect(tx.teamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", userId: { in: ["u1", "u2"] }, deactivatedAt: null },
      select: { userId: true, role: true },
    });
  });

  it("looks up a version below 1 as version 1", async () => {
    const tx = fakeTx([], []);
    await teamKeyVersionHolders(tx as never, "team-1", 0);
    expect(tx.teamMemberKey.findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1", keyVersion: 1 },
      select: { userId: true },
    });
  });

  it("returns no holder without reading memberships when no key row exists", async () => {
    const tx = fakeTx([], [{ userId: "u1", role: "OWNER" }]);
    expect(await teamKeyVersionHolders(tx as never, "team-1", 2)).toEqual([]);
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
