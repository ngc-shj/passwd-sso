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

const validBody = {
  ownerEphemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"abc","y":"def"}',
  encryptedSecretKey: "aabbccddeeff",
  secretKeyIv: "112233445566778899aabbcc",
  secretKeyAuthTag: "112233445566778899aabbccddeeff00",
  hkdfSalt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  wrapVersion: 1,
};

describe("POST /api/emergency-access/[id]/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: "ACCEPTED",
    });
    mockPrismaGrant.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when not owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when status is not ACCEPTED", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: "IDLE",
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("confirms key escrow successfully", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/confirm", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("IDLE");
    expect(mockPrismaGrant.update).toHaveBeenCalledWith({
      where: { id: "grant-1" },
      data: expect.objectContaining({ status: "IDLE" }),
    });
  });
});
