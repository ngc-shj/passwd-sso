import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockValidateScimToken, mockCheckScimRateLimit } = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
}));

vi.mock("@/lib/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));
vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));

import { GET } from "./route";

function makeReq() {
  return new NextRequest("http://localhost/api/scim/v2/Schemas");
}

describe("GET /api/scim/v2/Schemas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue({
      ok: true,
      data: { tokenId: "t1", teamId: "team-1", orgId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
    });
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns User and Group schemas", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("urn:ietf:params:scim:schemas:core:2.0:User");
    expect(body[1].id).toBe("urn:ietf:params:scim:schemas:core:2.0:Group");
  });

  it("User schema includes userName, name, active, externalId attributes", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    const userSchema = body[0];
    const attrNames = userSchema.attributes.map((a: { name: string }) => a.name);
    expect(attrNames).toContain("userName");
    expect(attrNames).toContain("name");
    expect(attrNames).toContain("active");
    expect(attrNames).toContain("externalId");
  });
});
