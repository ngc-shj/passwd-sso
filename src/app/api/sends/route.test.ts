import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockCreate,
  mockCheck,
  mockLogAudit,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: (tenantId: string) => unknown) => fn("tenant-1")),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { create: mockCreate },
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
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { POST } from "./route";

describe("POST /api/sends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
  });

  it("creates text send and returns 201 with Cache-Control: no-store", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "send-1", expiresAt });

    const res = await POST(
      createRequest("POST", "http://localhost/api/sends", {
        body: { name: "My Send", text: "secret text", expiresIn: "1d" },
      }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("send-1");
    expect(json.token).toBe("a".repeat(64));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
