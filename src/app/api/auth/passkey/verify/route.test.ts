import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockAuthorizeWebAuthn,
  mockCreateSession,
  mockSessionMetaRun,
  mockLogAudit,
  mockPrismaFindUnique,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockAssertOrigin: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockAuthorizeWebAuthn: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSessionMetaRun: vi.fn(),
  mockLogAudit: vi.fn(),
  mockPrismaFindUnique: vi.fn(),
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

vi.mock("@/lib/auth-adapter", () => ({
  createCustomAdapter: () => ({ createSession: mockCreateSession }),
}));

vi.mock("@/lib/session-meta", () => ({
  sessionMetaStorage: { run: mockSessionMetaRun },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));

vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: { AUTH_LOGIN: "AUTH_LOGIN" },
  AUDIT_SCOPE: { PERSONAL: "PERSONAL" },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockPrismaFindUnique } },
}));

vi.mock("@/lib/tenant-rls", () => ({
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
    mockCreateSession.mockResolvedValue({
      sessionToken: "tok",
      userId: "user-1",
      expires: new Date(),
    });
    // sessionMetaStorage.run: call the callback immediately
    mockSessionMetaRun.mockImplementation(
      (_meta: unknown, fn: () => unknown) => fn(),
    );
    // withBypassRls: call the callback directly
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown) => fn(),
    );
    // SSO tenant guard: user is in bootstrap tenant (allowed)
    mockPrismaFindUnique.mockResolvedValue({
      tenant: { isBootstrap: true },
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

  it("creates database session via adapter", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockSessionMetaRun).toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: expect.any(String),
        userId: "user-1",
        expires: expect.any(Date),
      }),
    );
  });

  it("logs audit event on success", async () => {
    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith({
      scope: "PERSONAL",
      action: "AUTH_LOGIN",
      userId: "user-1",
    });
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

  it("allows user without tenant record (null tenant)", async () => {
    mockPrismaFindUnique.mockResolvedValue({ tenant: null });

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("allows user not found in DB (null result)", async () => {
    mockPrismaFindUnique.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: validBody,
      headers: { origin: "http://localhost:3000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
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
