import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";

const requestedGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeId: "grantee-1",
  granteeEmail: "grantee@test.com",
  status: "REQUESTED",
  waitDays: 7,
};

describe("POST /api/emergency-access/[id]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue(requestedGrant);
    mockPrismaGrant.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when not owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when grant is not REQUESTED", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...requestedGrant, status: "IDLE" });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when grant is PENDING", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...requestedGrant, status: "PENDING" });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("approves REQUESTED grant successfully", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("ACTIVATED");
    expect(mockPrismaGrant.update).toHaveBeenCalledWith({
      where: { id: "grant-1" },
      data: {
        status: "ACTIVATED",
        activatedAt: expect.any(Date),
      },
    });
  });
});
