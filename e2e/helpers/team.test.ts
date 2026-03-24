/**
 * Unit tests for seedTeam and seedTeamMember (team.ts).
 * pg.Pool is mocked — no real database connection is made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── pg mock ────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: vi.fn() };
    }),
  },
}));

import { seedTeam, seedTeamMember } from "./team";
import { E2E_TENANT } from "./db";

// ─── Helpers ────────────────────────────────────────────────────

function getCall(index = 0): [string, unknown[]] {
  return mockQuery.mock.calls[index] as [string, unknown[]];
}

// ─── Tests ──────────────────────────────────────────────────────

describe("seedTeam", () => {
  const BASE_OPTIONS = {
    id: "00000000-0000-4000-a000-000000000001",
    name: "E2E Test Team",
    slug: "e2e-test-team",
    createdById: "00000000-0000-4000-b000-000000000001",
  };

  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once", async () => {
    await seedTeam(BASE_OPTIONS);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("inserts into teams table with team_key_version = 1", async () => {
    await seedTeam(BASE_OPTIONS);
    const [sql, params] = getCall();
    expect(sql).toMatch(/INSERT INTO teams/i);
    expect(sql).toMatch(/team_key_version/i);
    expect(params).toContain(1);
  });

  it("uses E2E_TENANT.id for tenant_id by default", async () => {
    await seedTeam(BASE_OPTIONS);
    const [, params] = getCall();
    expect(params).toContain(E2E_TENANT.id);
  });

  it("uses custom tenantId when provided", async () => {
    const customId = "custom-tenant-id";
    await seedTeam({ ...BASE_OPTIONS, tenantId: customId });
    const [, params] = getCall();
    expect(params).toContain(customId);
    expect(params).not.toContain(E2E_TENANT.id);
  });

  it("uses UPSERT on id (ON CONFLICT (id) DO UPDATE SET)", async () => {
    await seedTeam(BASE_OPTIONS);
    const [sql] = getCall();
    expect(sql).toMatch(/ON CONFLICT \(id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("passes team id, name, and slug in parameters", async () => {
    await seedTeam(BASE_OPTIONS);
    const [, params] = getCall();
    expect(params[0]).toBe(BASE_OPTIONS.id);
    expect(params).toContain(BASE_OPTIONS.name);
    expect(params).toContain(BASE_OPTIONS.slug);
  });
});

describe("seedTeamMember", () => {
  const BASE_OPTIONS = {
    teamId: "00000000-0000-4000-a000-000000000001",
    userId: "00000000-0000-4000-b000-000000000001",
    role: "OWNER" as const,
  };

  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once", async () => {
    await seedTeamMember(BASE_OPTIONS);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("inserts into team_members table", async () => {
    await seedTeamMember(BASE_OPTIONS);
    const [sql] = getCall();
    expect(sql).toMatch(/INSERT INTO team_members/i);
  });

  it("uses UPSERT on (team_id, user_id)", async () => {
    await seedTeamMember(BASE_OPTIONS);
    const [sql] = getCall();
    expect(sql).toMatch(/ON CONFLICT \(team_id, user_id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("passes the role parameter", async () => {
    await seedTeamMember(BASE_OPTIONS);
    const [, params] = getCall();
    expect(params).toContain("OWNER");
  });

  it("passes MEMBER role correctly", async () => {
    await seedTeamMember({ ...BASE_OPTIONS, role: "MEMBER" });
    const [, params] = getCall();
    expect(params).toContain("MEMBER");
  });

  it("passes ADMIN role correctly", async () => {
    await seedTeamMember({ ...BASE_OPTIONS, role: "ADMIN" });
    const [, params] = getCall();
    expect(params).toContain("ADMIN");
  });

  it("passes VIEWER role correctly", async () => {
    await seedTeamMember({ ...BASE_OPTIONS, role: "VIEWER" });
    const [, params] = getCall();
    expect(params).toContain("VIEWER");
  });

  it("uses E2E_TENANT.id for tenant_id by default", async () => {
    await seedTeamMember(BASE_OPTIONS);
    const [, params] = getCall();
    expect(params).toContain(E2E_TENANT.id);
  });

  it("uses custom tenantId when provided", async () => {
    const customId = "custom-tenant-id";
    await seedTeamMember({ ...BASE_OPTIONS, tenantId: customId });
    const [, params] = getCall();
    expect(params).toContain(customId);
    expect(params).not.toContain(E2E_TENANT.id);
  });

  it("passes teamId and userId in parameters", async () => {
    await seedTeamMember(BASE_OPTIONS);
    const [, params] = getCall();
    expect(params).toContain(BASE_OPTIONS.teamId);
    expect(params).toContain(BASE_OPTIONS.userId);
  });
});
