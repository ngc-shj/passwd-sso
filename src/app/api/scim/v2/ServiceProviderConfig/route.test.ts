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
  return new NextRequest("http://localhost/api/scim/v2/ServiceProviderConfig");
}

describe("GET /api/scim/v2/ServiceProviderConfig", () => {
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

  it("returns 429 when rate-limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(429);
  });

  it("returns ServiceProviderConfig with correct Content-Type", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/scim+json");
    const body = await res.json();
    expect(body.schemas).toContain(
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
    );
    expect(body.patch.supported).toBe(true);
    expect(body.filter.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
  });
});
