/**
 * Unit tests for the re-key E2E seeders (team-rekey.ts).
 * pg.Pool is mocked — no real database connection is made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: vi.fn() };
    }),
  },
}));

import { seedPendingTeamEntry, seedTeamAtKeyVersion, seedTeamKeyHolder } from "./team-rekey";
import { E2E_TENANT } from "./db";

const TEAM_ID = "00000000-0000-4000-a000-000000000001";
const USER_ID = "00000000-0000-4000-b000-000000000001";

function call(index: number): [string, unknown[]] {
  return mockQuery.mock.calls[index] as [string, unknown[]];
}

beforeEach(() => {
  mockQuery.mockClear();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("seedTeamAtKeyVersion", () => {
  it("inserts the team at the given key version in the E2E tenant", async () => {
    await seedTeamAtKeyVersion({ id: TEAM_ID, name: "t", slug: "t", teamKeyVersion: 2 });
    const [sql, params] = call(0);
    expect(sql).toMatch(/INSERT INTO teams/);
    expect(params).toEqual([TEAM_ID, E2E_TENANT.id, "t", "t", 2]);
  });

  it("rejects a version below 1 without writing", async () => {
    await expect(seedTeamAtKeyVersion({ id: TEAM_ID, name: "t", slug: "t", teamKeyVersion: 0 })).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("seedTeamKeyHolder", () => {
  it("inserts a key-distributed membership and one member-key row per version", async () => {
    await seedTeamKeyHolder({ teamId: TEAM_ID, userId: USER_ID, role: "OWNER", keyVersions: [1, 2] });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(call(0)[0]).toMatch(/INSERT INTO team_members[\s\S]*key_distributed[\s\S]*true/);
    expect(call(1)[0]).toMatch(/INSERT INTO team_member_keys/);
    expect(call(1)[1].at(-1)).toBe(1);
    expect(call(2)[1].at(-1)).toBe(2);
  });
});

describe("seedPendingTeamEntry", () => {
  it("inserts a v1 entry whose ItemKey predates the team key version, returning its snapshot IVs", async () => {
    const entry = await seedPendingTeamEntry({ teamId: TEAM_ID, createdById: USER_ID, teamKeyVersion: 2, itemKeyCreatedAt: 1 });
    const [sql, params] = call(0);
    expect(sql).toMatch(/INSERT INTO team_password_entries/);
    expect(params).toEqual(expect.arrayContaining([entry.id, entry.blobIv, entry.overviewIv, entry.itemKeyIv]));
    // team_key_version 2, item_key_version 1, item_key_team_key_version 1.
    expect(params[10]).toBe(2);
    expect(params[11]).toBe(1);
    expect(params[16]).toBe(1);
  });

  it("refuses an entry that would not be pending", async () => {
    await expect(
      seedPendingTeamEntry({ teamId: TEAM_ID, createdById: USER_ID, teamKeyVersion: 2, itemKeyCreatedAt: 2 }),
    ).rejects.toThrow(/predate/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
