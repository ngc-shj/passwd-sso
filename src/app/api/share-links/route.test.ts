import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockPasswordEntryFindUnique,
  mockPasswordShareCreate,
  mockCheck,
  mockLogAuditInTx,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockAssertQuotaAvailable,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPasswordEntryFindUnique: vi.fn(),
  mockPasswordShareCreate: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAuditInTx: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: (tenantId: string) => unknown) => fn("tenant-1")),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn({})),
  mockAssertQuotaAvailable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockPasswordEntryFindUnique },
    passwordShare: { create: mockPasswordShareCreate },
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
  encryptShareData: () => ({
    ciphertext: "encrypted",
    iv: "i".repeat(24),
    authTag: "t".repeat(32),
    masterKeyVersion: 1,
  }),
  generateAccessPassword: () => "generated-pw",
  hashAccessPassword: () => ({ hash: "hashed-pw", version: 1 }),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  teamAuditBase: vi.fn((_req, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { AUDIT_WRITE: "AUDIT_WRITE", TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE", CROSS_TENANT_LOOKUP: "CROSS_TENANT_LOOKUP" },
}));
vi.mock("@/lib/quota/resource-quotas", () => ({
  assertQuotaAvailable: mockAssertQuotaAvailable,
  QuotaExceededError: class QuotaExceededError extends Error {
    resource: string; current: number; max: number;
    constructor(resource: string, current: number, max: number) {
      super("quota exceeded");
      this.resource = resource; this.current = current; this.max = max;
    }
  },
}));

import { POST } from "./route";

describe("POST /api/share-links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockAssertQuotaAvailable.mockResolvedValue(undefined);
  });

  it("creates share link and returns 201 with Cache-Control: no-store", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockPasswordEntryFindUnique.mockResolvedValue({
      userId: DEFAULT_SESSION.user.id,
      entryType: "LOGIN",
      tenantId: "tenant-1",
    });
    const expiresAt = new Date(Date.now() + 86400_000);
    mockPasswordShareCreate.mockResolvedValue({ id: "share-1", expiresAt });

    const res = await POST(
      createRequest("POST", "http://localhost/api/share-links", {
        body: {
          passwordEntryId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
          data: { title: "My Entry", username: "user", password: "pw" },
          expiresIn: "1d",
          permissions: [],
        },
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("share-1");
    expect(json.token).toBe("a".repeat(64));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
