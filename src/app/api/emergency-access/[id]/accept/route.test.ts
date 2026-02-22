import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockTransaction, mockRateLimiter, mockSendEmail } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: { findUnique: vi.fn(), update: vi.fn() },
  mockPrismaUser: { findUnique: vi.fn() },
  mockTransaction: vi.fn(),
  mockRateLimiter: { check: vi.fn() },
  mockSendEmail: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    emergencyAccessKeyPair: { create: vi.fn() },
    user: mockPrismaUser,
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => mockRateLimiter,
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const validBody = {
  granteePublicKey: "public-key-base64",
  encryptedPrivateKey: {
    ciphertext: "cipher",
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
  },
};

const pendingGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeEmail: "grantee@example.com",
  granteeId: null,
  status: EA_STATUS.PENDING,
  tokenExpiresAt: new Date(Date.now() + 86400_000), // 1 day from now
};

describe("POST /api/emergency-access/[id]/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "grantee@example.com" } });
    mockRateLimiter.check.mockResolvedValue(true);
    mockPrismaGrant.findUnique.mockResolvedValue(pendingGrant);
    mockTransaction.mockResolvedValue([{}, {}]);
    mockPrismaUser.findUnique.mockResolvedValue({ email: "owner@test.com", name: "Owner Name" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when user has no email", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: null } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiter.check.mockResolvedValue(false);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(429);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when grant is not pending", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({ ...pendingGrant, status: EA_STATUS.ACCEPTED });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("GRANT_NOT_PENDING");
  });

  it("returns 410 when invitation is expired", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue({
      ...pendingGrant,
      tokenExpiresAt: new Date(Date.now() - 1000), // expired
    });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(410);
  });

  it("returns 403 when email does not match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "grantee-1", email: "other@example.com" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when owner tries to accept own grant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "owner-1", email: "grantee@example.com" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("CANNOT_GRANT_SELF");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/emergency-access/grant-1/accept", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, createParams({ id: "grant-1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: {} }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("successfully accepts grant", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/accept", { body: validBody }),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe(EA_STATUS.ACCEPTED);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Sends accepted email to owner
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@test.com" })
    );
  });
});
