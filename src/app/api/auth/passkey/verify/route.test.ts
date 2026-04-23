import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockAuthorizeWebAuthn,
  mockLogAudit,
  mockPrismaFindUnique,
  mockPrismaSessionDeleteMany,
  mockPrismaSessionCreate,
  mockPrismaTransaction,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockAssertOrigin: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockAuthorizeWebAuthn: vi.fn(),
  mockLogAudit: vi.fn(),
  mockPrismaFindUnique: vi.fn(),
  mockPrismaSessionDeleteMany: vi.fn(),
  mockPrismaSessionCreate: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/webauthn-authorize", () => ({
  authorizeWebAuthn: mockAuthorizeWebAuthn,
}));

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({
    ip: null,
    userAgent: null,
    acceptLanguage: null,
  }),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: null,
    userAgent: null,
  }),
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  AUDIT_ACTION: {
    AUTH_LOGIN: "AUTH_LOGIN",
    SESSION_REVOKE_ALL: "SESSION_REVOKE_ALL",
    EXTENSION_TOKEN_FAMILY_REVOKED: "EXTENSION_TOKEN_FAMILY_REVOKED",
  },
  AUDIT_SCOPE: { PERSONAL: "PERSONAL" },
}));

vi.mock("@/lib/auth/extension-token", () => ({
  revokeAllExtensionTokensForUser: vi.fn().mockResolvedValue({ rowsRevoked: 0, familiesRevoked: 0 }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaFindUnique },
    $transaction: mockPrismaTransaction,
    session: {
      deleteMany: mockPrismaSessionDeleteMany,
      create: mockPrismaSessionCreate,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/url-helpers", () => ({
  isHttps: false,
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/verify";

const validBody = {
  credentialResponse: JSON.stringify({ id: "cred-1", type: "public-key" }),
  challengeId: "a".repeat(32),
};

const mockUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
};

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/auth/passkey/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockAuthorizeWebAuthn.mockResolvedValue(mockUser);

    // withBypassRls: call the callback directly
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown) => fn(),
    );

    // SSO tenant guard: user is in bootstrap tenant (allowed)
    mockPrismaFindUnique.mockResolvedValue({
      tenantId: "tenant-1",
      tenant: { isBootstrap: true },
    });

    // $transaction: execute callback with a mock tx that has session methods
    mockPrismaTransaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const tx = {
          session: {
            deleteMany: mockPrismaSessionDeleteMany,
            create: mockPrismaSessionCreate,
          },
        };
        return fn(tx);
      },
    );
    mockPrismaSessionDeleteMany.mockResolvedValue({ count: 0 });
    mockPrismaSessionCreate.mockResolvedValue({
      sessionToken: "tok",
      userId: "user-1",
      expires: new Date(),
    });
  });

  it("returns 200 with session cookie on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);

    // Session cookie set
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("authjs.session-token=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("calls authorizeWebAuthn with correct params", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockAuthorizeWebAuthn).toHaveBeenCalledWith({
      credentialResponse: validBody.credentialResponse,
      challengeId: validBody.challengeId,
    });
  });

  it("creates database session via atomic transaction", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockPrismaTransaction).toHaveBeenCalledOnce();
    expect(mockPrismaSessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(mockPrismaSessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionToken: expect.any(String),
        userId: "user-1",
        tenantId: "tenant-1",
        expires: expect.any(Date),
      }),
    });
  });

  it("calls deleteMany before create", async () => {
    const callOrder: string[] = [];
    mockPrismaSessionDeleteMany.mockImplementation(async () => {
      callOrder.push("deleteMany");
      return { count: 2 };
    });
    mockPrismaSessionCreate.mockImplementation(async () => {
      callOrder.push("create");
      return { sessionToken: "tok", userId: "user-1", expires: new Date() };
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(callOrder).toEqual(["deleteMany", "create"]);
  });

  it("logs SESSION_REVOKE_ALL when existing sessions are evicted", async () => {
    mockPrismaSessionDeleteMany.mockResolvedValue({ count: 3 });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "SESSION_REVOKE_ALL",
        userId: "user-1",
        metadata: { trigger: "passkey_signin", evictedCount: 3 },
      }),
    );
  });

  it("does not log SESSION_REVOKE_ALL when no sessions evicted", async () => {
    mockPrismaSessionDeleteMany.mockResolvedValue({ count: 0 });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    const revokeAllCalls = mockLogAudit.mock.calls.filter(
      ([arg]: [{ action: string }]) => arg.action === "SESSION_REVOKE_ALL",
    );
    expect(revokeAllCalls).toHaveLength(0);
  });

  it("logs audit event on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "AUTH_LOGIN",
        userId: "user-1",
        ip: null,
        userAgent: null,
      }),
    );
  });

  it("returns 403 when origin is invalid", async () => {
    const { NextResponse } = await import("next/server");
    mockAssertOrigin.mockReturnValue(
      NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    );

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://evil.com" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: "not-json",
    } as ConstructorParameters<typeof import("next/server").NextRequest>[1]);
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_REQUEST");
  });

  it("returns 400 when credentialResponse is not a string", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: { credentialResponse: 123, challengeId: "a".repeat(32) },
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_REQUEST");
  });

  it("returns 401 when authorizeWebAuthn returns null", async () => {
    mockAuthorizeWebAuthn.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 for SSO tenant user (non-bootstrap)", async () => {
    mockPrismaFindUnique.mockResolvedValue({
      tenantId: "tenant-sso",
      tenant: { isBootstrap: false },
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when tenant relation is null (orphaned FK)", async () => {
    mockPrismaFindUnique.mockResolvedValue({ tenantId: "tenant-1", tenant: null });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when user not found in DB (null result)", async () => {
    mockPrismaFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 when user has no tenantId", async () => {
    mockPrismaFindUnique.mockResolvedValue({ tenantId: null, tenant: null });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));
    expect(status).toBe(401);
    expect(json.error).toBe("AUTHENTICATION_FAILED");
  });

  it("includes PRF data in response when credential supports PRF", async () => {
    const prfData = {
      prfEncryptedSecretKey: "enc-key-hex",
      prfSecretKeyIv: "iv-hex",
      prfSecretKeyAuthTag: "tag-hex",
    };
    mockAuthorizeWebAuthn.mockResolvedValue({ ...mockUser, prf: prfData });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.prf).toEqual(prfData);
  });

  it("omits PRF data when credential does not support PRF", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.prf).toBeUndefined();
  });
});
