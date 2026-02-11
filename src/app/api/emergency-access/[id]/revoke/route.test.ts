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

describe("POST /api/emergency-access/[id]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: "IDLE",
    });
    mockPrismaGrant.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("permanently revokes grant", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("REVOKED");
    expect(mockPrismaGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REVOKED",
          encryptedSecretKey: null,
        }),
      })
    );
  });

  it("rejects request (non-permanent, back to IDLE)", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: "REQUESTED",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: false },
      }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("IDLE");
  });

  it("returns 400 when already revoked", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: "REVOKED",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });
});
