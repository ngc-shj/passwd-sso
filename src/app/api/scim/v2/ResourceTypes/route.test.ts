import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockValidateScimToken, mockCheckScimRateLimit } = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
}));
const { mockWithTenantRls } = vi.hoisted(() => ({
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));
vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: mockWithTenantRls,
}));

import { GET } from "./route";

function makeReq() {
  return new NextRequest("http://localhost/api/scim/v2/ResourceTypes");
}

describe("GET /api/scim/v2/ResourceTypes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue({
      ok: true,
      data: { tokenId: "t1", teamId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
    });
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 401 when token is invalid", async () => {
    mockValidateScimToken.mockResolvedValue({ ok: false, error: "SCIM_TOKEN_INVALID" });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns User and Group resource types", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("User");
    expect(body[1].id).toBe("Group");
    expect(body[0].endpoint).toBe("/Users");
    expect(body[1].endpoint).toBe("/Groups");
  });
});
