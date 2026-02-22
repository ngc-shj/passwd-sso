import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockSendEmail } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
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
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: () => Promise.resolve(true) }),
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

describe("POST /api/emergency-access/[id]/request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.IDLE,
      waitDays: 7,
    });
    mockPrismaGrant.update.mockResolvedValue({});
    mockPrismaUser.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "owner-1") return Promise.resolve({ email: "owner@test.com", name: "Owner Name" });
      if (where.id === "grantee-1") return Promise.resolve({ email: "grantee@test.com", name: "Grantee Name" });
      return Promise.resolve(null);
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/request"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when not grantee", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/request"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when status not IDLE", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      granteeId: "grantee-1",
      status: EA_STATUS.PENDING,
      waitDays: 7,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/request"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("creates emergency request successfully", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/request"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.REQUESTED);
    expect(json.waitExpiresAt).toBeTruthy();
    expect(mockPrismaGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant-1" },
        data: expect.objectContaining({ status: EA_STATUS.REQUESTED }),
      })
    );
    // Sends requested email to owner
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@test.com" })
    );
  });

  it("returns 400 when grant is STALE", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      granteeId: "grantee-1",
      status: EA_STATUS.STALE,
      waitDays: 7,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/request"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });
});