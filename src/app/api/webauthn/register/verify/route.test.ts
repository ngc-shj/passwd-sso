import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRateLimiterCheck,
  mockGetRedis,
  mockRedisGetdel,
  mockVerifyRegistration,
  mockUint8ArrayToBase64url,
  mockGetRpOrigin,
  mockLogAudit,
  mockPrismaUserFindUnique,
  mockPrismaCredentialCreate,
  mockWithUserTenantRls,
  mockSendEmail,
  mockParseDeviceFromUserAgent,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisGetdel: vi.fn(),
  mockVerifyRegistration: vi.fn(),
  mockUint8ArrayToBase64url: vi.fn((b: Uint8Array) => Buffer.from(b).toString("base64url")),
  mockGetRpOrigin: vi.fn(() => "https://example.com"),
  mockLogAudit: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaCredentialCreate: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockSendEmail: vi.fn(),
  mockParseDeviceFromUserAgent: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/webauthn-server", () => ({
  verifyRegistration: mockVerifyRegistration,
  uint8ArrayToBase64url: mockUint8ArrayToBase64url,
  getRpOrigin: mockGetRpOrigin,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null, acceptLanguage: null }),
}));

vi.mock("@/lib/constants", () => ({
  AUDIT_ACTION: { WEBAUTHN_CREDENTIAL_REGISTER: "WEBAUTHN_CREDENTIAL_REGISTER" },
  AUDIT_SCOPE: { PERSONAL: "PERSONAL" },
  AUDIT_TARGET_TYPE: { WEBAUTHN_CREDENTIAL: "WEBAUTHN_CREDENTIAL" },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaUserFindUnique },
    webAuthnCredential: { create: mockPrismaCredentialCreate },
  },
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/parse-user-agent", () => ({
  parseDeviceFromUserAgent: mockParseDeviceFromUserAgent,
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));

vi.mock("@/lib/email/templates/passkey-registered", () => ({
  passkeyRegisteredEmail: () => ({ subject: "s", html: "<p>hi</p>", text: "hi" }),
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

vi.mock("@/lib/api-error-codes", () => ({
  API_ERROR: {
    UNAUTHORIZED: "UNAUTHORIZED",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    VALIDATION_ERROR: "VALIDATION_ERROR",
  },
}));

vi.mock("@/lib/parse-body", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseBody: async (req: any, _schema: any) => {
    const body = await req.json();
    return { ok: true, data: body };
  },
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/register/verify";

function makeResponse(credPropsOverride?: Record<string, unknown>) {
  return {
    id: "cred-id-1",
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50RGF0YQ",
      attestationObject: "YXR0ZXN0YXRpb24",
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: credPropsOverride ?? {},
  };
}

function makeBody(credPropsOverride?: Record<string, unknown>) {
  return {
    response: makeResponse(credPropsOverride),
    nickname: "Test Key",
  };
}

const mockRegistrationInfo = {
  credentialID: new Uint8Array([1, 2, 3]),
  credentialPublicKey: new Uint8Array([4, 5, 6]),
  counter: 0,
  credentialDeviceType: "multiDevice",
  credentialBackedUp: true,
};

const now = new Date("2026-03-16T00:00:00Z");

function makeCreatedCredential(discoverable: boolean | null) {
  return {
    id: "cred-db-id",
    credentialId: "AQID",
    nickname: "Test Key",
    deviceType: "multiDevice",
    backedUp: true,
    discoverable,
    prfSupported: false,
    createdAt: now,
  };
}

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/webauthn/register/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.WEBAUTHN_RP_ID = "example.com";

    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "test@example.com" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ getdel: mockRedisGetdel });
    mockRedisGetdel.mockResolvedValue("test-challenge");
    mockVerifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: mockRegistrationInfo,
    });
    mockPrismaUserFindUnique.mockResolvedValue({ tenantId: "tenant-1", locale: "ja" });
    mockParseDeviceFromUserAgent.mockReturnValue("Chrome on macOS");
    // withUserTenantRls: execute the callback directly
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
  });

  // ── credProps.rk extraction tests ───────────────────────────

  describe("credProps.rk extraction", () => {
    it("passes discoverable=true to Prisma when credProps.rk is true", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(true));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: true } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: true }),
        }),
      );
    });

    it("passes discoverable=false to Prisma when credProps.rk is false", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(false));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: false } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: false }),
        }),
      );
    });

    it("passes discoverable=null to Prisma when credProps.rk is null", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: null } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: null }),
        }),
      );
    });

    it("passes discoverable=null to Prisma when credProps is absent", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: null }),
        }),
      );
    });

    it("passes discoverable=null to Prisma when credProps.rk is invalid type (string)", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: "true" } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: null }),
        }),
      );
    });

    it("passes discoverable=null to Prisma when credProps.rk is invalid type (number)", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: 1 } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ discoverable: null }),
        }),
      );
    });
  });

  // ── Audit log ───────────────────────────────────────────────

  describe("audit log", () => {
    it("includes discoverable=true in audit metadata", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(true));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: true } }),
      });
      await POST(req);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ discoverable: true }),
        }),
      );
    });

    it("includes discoverable=false in audit metadata", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(false));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ credProps: { rk: false } }),
      });
      await POST(req);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ discoverable: false }),
        }),
      );
    });

    it("includes discoverable=null in audit metadata when credProps absent", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({}),
      });
      await POST(req);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ discoverable: null }),
        }),
      );
    });
  });

  // ── Auth guard ──────────────────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 503 when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false });

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });
});
