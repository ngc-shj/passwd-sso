import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockSendEmail } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockSendEmail: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant, user: mockPrismaUser },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const pendingGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeEmail: "grantee@example.com",
  status: EA_STATUS.PENDING,
};

describe("POST /api/emergency-access/[id]/decline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "grantee@example.com" } });
    mockPrismaGrant.findUnique.mockResolvedValue(pendingGrant);
    mockPrismaGrant.update.mockResolvedValue({});
    mockPrismaUser.findUnique.mockResolvedValue({ email: "owner@test.com", name: "Owner Name" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when user has no email", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: null } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when grant is not pending", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...pendingGrant, status: EA_STATUS.ACCEPTED });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("GRANT_NOT_PENDING");
  });

  it("returns 403 when email does not match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "other@example.com" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("successfully declines grant", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/decline"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe(EA_STATUS.REJECTED);
    expect(mockPrismaGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant-1" },
        data: { status: EA_STATUS.REJECTED },
      })
    );
    // Sends declined email to owner
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@test.com",
        subject: expect.stringContaining("辞退"),
      })
    );
  });
});
