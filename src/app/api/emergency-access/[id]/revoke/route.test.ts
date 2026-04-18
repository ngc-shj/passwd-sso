import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockSendEmail, mockWithUserTenantRls, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    findUnique: vi.fn(),
    update: vi.fn(),
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
vi.mock("@/lib/audit", () => ({
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

describe("POST /api/emergency-access/[id]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.IDLE,
    });
    mockPrismaGrant.update.mockResolvedValue({});
    mockPrismaUser.findUnique.mockResolvedValue({ email: "grantee@test.com", name: "Grantee Name" });
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

  it("revokes successfully even when grantee user not found (deleted account)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
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
    expect(json.status).toBe(EA_STATUS.REVOKED);
    expect(mockPrismaGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EA_STATUS.REVOKED,
          encryptedSecretKey: null,
        }),
      })
    );
    // Cross-tenant grantee lookup uses withBypassRls
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    // Sends revoked email to grantee
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grantee@test.com",
        subject: expect.stringContaining("revoked"),
      })
    );
  });

  it("rejects request (non-permanent, back to IDLE)", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: EA_STATUS.REQUESTED,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: false },
      }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.IDLE);
  });

  it("returns 400 when already revoked", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      status: EA_STATUS.REVOKED,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
  });

  it("revokes STALE grant", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      ownerId: "owner-1",
      granteeId: "grantee-1",
      status: EA_STATUS.STALE,
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/revoke", {
        body: { permanent: true },
      }),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.REVOKED);
  });
});
