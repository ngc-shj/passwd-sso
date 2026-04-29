import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockSendEmail, mockWithUserTenantRls, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn() },
  mockSendEmail: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant, user: mockPrismaUser },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const requestedGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeId: "grantee-1",
  granteeEmail: "grantee@test.com",
  status: EA_STATUS.REQUESTED,
  waitDays: 7,
};

describe("POST /api/emergency-access/[id]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue(requestedGrant);
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaUser.findUnique.mockResolvedValue({ email: "grantee@test.com", name: "Grantee Name" });
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

  it("returns 400 when status CAS finds no eligible row (e.g. concurrent revoke)", async () => {
    // Simulates the race: findUnique sees REQUESTED, but by the time the CAS
    // updateMany runs, the row's status has moved out of the permitted from-set.
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("approves successfully even when grantee user not found (deleted account)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("approves REQUESTED grant successfully", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.ACTIVATED);
    expect(mockPrismaGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        ownerId: "owner-1",
        status: { in: expect.arrayContaining([EA_STATUS.REQUESTED]) },
      },
      data: {
        status: EA_STATUS.ACTIVATED,
        activatedAt: expect.any(Date),
      },
    });
    // Cross-tenant grantee lookup uses withBypassRls
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    // Sends approved email to grantee
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grantee@test.com",
        subject: expect.stringContaining("approved"),
      })
    );
  });
});
