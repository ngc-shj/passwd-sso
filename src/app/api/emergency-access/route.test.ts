import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaGrant, mockPrismaUser, mockExecuteRaw, mockCheck, mockSendEmail, mockWithUserTenantRls, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaGrant: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  mockPrismaUser: { findUnique: vi.fn(), findFirst: vi.fn() },
  mockExecuteRaw: vi.fn().mockResolvedValue(undefined),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockSendEmail: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emergencyAccessGrant: mockPrismaGrant, user: mockPrismaUser, $executeRaw: mockExecuteRaw },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "mock-token-hex",
  hashToken: (t: string) => `hashed-${t}`,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST, GET } from "./route";
import { EA_STATUS } from "@/lib/constants";

describe("POST /api/emergency-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1", email: "owner@test.com" } });
    mockPrismaGrant.findFirst.mockResolvedValue(null);
    mockPrismaGrant.create.mockResolvedValue({
      id: "grant-1",
      status: EA_STATUS.PENDING,
      granteeEmail: "grantee@test.com",
      waitDays: 7,
      tokenExpiresAt: new Date("2099-01-01"),
    });
    mockPrismaUser.findUnique.mockResolvedValue({ email: "owner@test.com", name: "Owner Name" });
    mockExecuteRaw.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValueOnce({ allowed: false });
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(429);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = createRequest("POST", "http://localhost/api/emergency-access");
    vi.spyOn(req, "json").mockRejectedValue(new Error("parse error"));
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid waitDays", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 5 },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for self-invite", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "owner@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(400);
  });

  it("matches an existing grant and the grantee's locale by exact address, not as a pattern", async () => {
    // Round-8 R8-S4: insensitive `equals` compiles to an unescaped ILIKE, so `_` and
    // `%` in an address matched other grants and other users.
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "gr_ntee@test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(201);
    expect(mockPrismaGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ granteeEmail: { in: ["gr_ntee@test.com"], mode: "insensitive" } }),
      }),
    );
    expect(mockPrismaUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { in: ["gr_ntee@test.com"], mode: "insensitive" } } }),
    );
  });

  it("takes the (owner, grantee) lock before the duplicate read and the create", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "Grantee@Test.com", waitDays: 7 },
    }));
    expect(res.status).toBe(201);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Tagged-template call: the key is the first interpolated value.
    expect(mockExecuteRaw.mock.calls[0][1]).toBe("emergency-grant:owner-1:grantee@test.com");
    const lockOrder = mockExecuteRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(mockPrismaGrant.findFirst.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(mockPrismaGrant.create.mock.invocationCallOrder[0]);
  });

  it("runs the duplicate read and the create in one withUserTenantRls transaction", async () => {
    await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    expect(mockWithUserTenantRls).toHaveBeenCalledTimes(1);
  });

  describe("duplicate check clock", () => {
    const clock = new Date("2026-06-01T00:00:00Z");
    const expectedWhere = {
      ownerId: "owner-1",
      granteeEmail: { in: ["grantee@test.com"], mode: "insensitive" },
      status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] },
      NOT: { status: EA_STATUS.PENDING, tokenExpiresAt: { lt: clock } },
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(clock);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("excludes expired PENDING invites from the duplicate check", async () => {
      const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
        body: { granteeEmail: "grantee@test.com", waitDays: 7 },
      }));
      expect(res.status).toBe(201);
      expect(mockPrismaGrant.findFirst).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("returns 409 for duplicate grant", async () => {
      mockPrismaGrant.findFirst.mockResolvedValue({ id: "existing" });
      const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
        body: { granteeEmail: "grantee@test.com", waitDays: 7 },
      }));
      expect(res.status).toBe(409);
      expect(mockPrismaGrant.create).not.toHaveBeenCalled();
      expect(mockPrismaGrant.findFirst).toHaveBeenCalledWith({ where: expectedWhere });
    });
  });

  it("creates grant with hashed token and returns plaintext token", async () => {
    const res = await POST(createRequest("POST", "http://localhost/api/emergency-access", {
      body: { granteeEmail: "grantee@test.com", waitDays: 7 },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("grant-1");
    expect(json.token).toBe("mock-token-hex"); // plaintext token in response
    expect(json.status).toBe(EA_STATUS.PENDING);
    // DB stores hashed token
    expect(mockPrismaGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: "hashed-mock-token-hex",
        }),
      })
    );
    // withBypassRls used for cross-tenant grantee lookup; withUserTenantRls for owner-scoped ops
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockWithUserTenantRls).toHaveBeenCalled();
    // Sends invite email to grantee
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grantee@test.com",
        subject: expect.stringContaining("emergency contact"),
      })
    );
  });
});

describe("GET /api/emergency-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@test.com" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns grant list without token hash", async () => {
    mockPrismaGrant.findMany.mockResolvedValue([
      {
        id: "grant-1",
        ownerId: "user-1",
        granteeId: null,
        granteeEmail: "grantee@test.com",
        status: EA_STATUS.PENDING,
        waitDays: 7,
        keyAlgorithm: "ECDH-P256",
        tokenHash: "hashed-tok",
        requestedAt: null,
        activatedAt: null,
        waitExpiresAt: null,
        revokedAt: null,
        createdAt: new Date("2025-01-01"),
        owner: { id: "user-1", name: "Owner", email: "user@test.com", image: null },
        grantee: null,
      },
    ]);

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("grant-1");
    // Token hash is never exposed in GET
    expect(json[0].token).toBeUndefined();
    expect(json[0].tokenHash).toBeUndefined();
  });

  it("lists pending grants addressed to this user by exact address, not as a pattern", async () => {
    // Round-8 R8-S4: a session email with `_` matched another grantee's pending
    // grants, and the owner's identity with them.
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "us_r@test.com" } });
    mockPrismaGrant.findMany.mockResolvedValue([]);

    await GET();

    expect(mockPrismaGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            { granteeEmail: { in: ["us_r@test.com"], mode: "insensitive" }, status: EA_STATUS.PENDING },
          ]),
        },
      }),
    );
  });
});
