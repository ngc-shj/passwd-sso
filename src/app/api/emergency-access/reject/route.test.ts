import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

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
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed-${t}`,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const validGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeEmail: "grantee@test.com",
  status: EA_STATUS.PENDING,
};

describe("POST /api/emergency-access/reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "grantee@test.com" } });
    mockPrismaGrant.findUnique.mockResolvedValue(validGrant);
    mockPrismaGrant.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "tok" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = createRequest("POST", "http://localhost/api/emergency-access/reject");
    // Override json() to throw
    vi.spyOn(req, "json").mockRejectedValue(new Error("parse error"));
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when token invalid", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "invalid-token" },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when invitation not PENDING", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...validGrant, status: EA_STATUS.ACCEPTED });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "tok" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 403 when email doesn't match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "other@test.com" } });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "tok" },
    }));
    expect(res.status).toBe(403);
  });

  it("looks up grant by tokenHash", async () => {
    await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "tok" },
    }));
    expect(mockPrismaGrant.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: "hashed-tok" },
    });
  });

  it("rejects invitation successfully", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access/reject", {
      body: { token: "tok" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.REJECTED);
    expect(mockPrismaGrant.update).toHaveBeenCalledWith({
      where: { id: "grant-1" },
      data: { status: EA_STATUS.REJECTED },
    });
  });
});