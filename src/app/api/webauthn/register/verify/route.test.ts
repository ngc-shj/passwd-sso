import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import type { verifyRegistration } from "@/lib/auth/webauthn/webauthn-server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

// T6 (Round-1 plan): mockVerifyRegistration typed against verifyRegistration's
// real signature so a future @simplewebauthn major bump that changes
// VerifiedRegistrationResponse's shape becomes a compile-time error rather
// than a silent vacuous-pass test.

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockRateLimiterCheck,
  mockCreateRateLimiter,
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
} = vi.hoisted(() => {
  const mockRateLimiterCheck = vi.fn();
  return {
    mockAuth: vi.fn(),
    mockRateLimiterCheck,
    // F: recording factory — assertRedisFailClosed's factory-attribution step
    // reads mockCreateRateLimiter.mock.{calls,results}.
    mockCreateRateLimiter: vi.fn((_opts: unknown) => ({ check: mockRateLimiterCheck, clear: vi.fn() })),
    mockGetRedis: vi.fn(),
    mockRedisGetdel: vi.fn(),
    mockVerifyRegistration: vi.fn() as Mock<typeof verifyRegistration>,
    mockUint8ArrayToBase64url: vi.fn((b: Uint8Array) => Buffer.from(b).toString("base64url")),
    mockGetRpOrigin: vi.fn(() => "https://example.com"),
    mockLogAudit: vi.fn(),
    mockPrismaUserFindUnique: vi.fn(),
    mockPrismaCredentialCreate: vi.fn(),
    mockWithUserTenantRls: vi.fn(),
    mockSendEmail: vi.fn(),
    mockParseDeviceFromUserAgent: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  verifyRegistration: mockVerifyRegistration,
  uint8ArrayToBase64url: mockUint8ArrayToBase64url,
  getRpOrigin: mockGetRpOrigin,
  // A02-8: route imports the regex constant to validate Redis-sourced
  // per-cred salt before persisting. Mock matches the production export.
  PER_CRED_SALT_HEX_RE: /^[0-9a-f]{64}$/,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null, acceptLanguage: null }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
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

vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

vi.mock("@/lib/http/api-error-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/api-error-codes")>()),
}));

vi.mock("@/lib/http/parse-body", () => ({
  // Note: parseBody mock bypasses Zod schema validation (including the PRF
  // all-or-nothing refine rule). Schema validation is implicitly tested by
  // the production build's TypeScript checks and integration tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseBody: async (req: any, _schema: any) => {
    const body = await req.json();
    return { ok: true, data: body };
  },
}));

import { POST } from "./route";

// Module-level `rateLimiter = createRateLimiter(...)` runs at import time,
// above. Snapshot the recorded factory call now (module scope, before any
// test/beforeEach executes) — the global beforeEach's vi.clearAllMocks()
// would otherwise wipe mockCreateRateLimiter.mock.calls/.results before the
// first test runs.
const rateLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const rateLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockRateLimiterCheck;
};

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/register/verify";

function makeResponse(credPropsOverride?: Record<string, unknown>) {
  const innerResponse: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  } = {
    clientDataJSON: "Y2xpZW50RGF0YQ",
    attestationObject: "YXR0ZXN0YXRpb24",
    transports: ["internal", "hybrid"],
  };
  return {
    id: "cred-id-1",
    type: "public-key",
    response: innerResponse,
    clientExtensionResults: credPropsOverride ?? {},
  };
}

const CHALLENGE_ID = "0123456789abcdef0123456789abcdef";

function makeBody(credPropsOverride?: Record<string, unknown>) {
  return {
    response: makeResponse(credPropsOverride),
    challengeId: CHALLENGE_ID,
    nickname: "Test Key",
  };
}

// v11 shape: per-credential fields nested under .credential, while
// credentialDeviceType / credentialBackedUp stay at the top level. The full
// VerifiedRegistrationResponse type includes additional metadata
// (fmt / aaguid / credentialType / attestationObject / userVerified / origin)
// — production code only reads the subset spelled out below, but T6 typing
// requires the mock to satisfy the entire v11 contract.
type VerifiedReg = NonNullable<
  Awaited<ReturnType<typeof verifyRegistration>>["registrationInfo"]
>;
const mockRegistrationInfo: VerifiedReg = {
  fmt: "none",
  aaguid: "00000000-0000-0000-0000-000000000000",
  credential: {
    id: "AQID", // base64url("\x01\x02\x03")
    publicKey: new Uint8Array([4, 5, 6]),
    counter: 0,
  },
  credentialType: "public-key",
  attestationObject: new Uint8Array([0, 0, 0]),
  userVerified: true,
  credentialDeviceType: "multiDevice",
  credentialBackedUp: true,
  origin: "https://example.com",
  rpID: "example.com",
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
    minPinLength: null,
    largeBlobSupported: null,
    createdAt: now,
  };
}

// ── Setup ────────────────────────────────────────────────────

describe("POST /api/webauthn/register/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubEnv("WEBAUTHN_RP_ID", "example.com");

    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "test@example.com" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ getdel: mockRedisGetdel });
    // A02-8: register-options now caches a JSON envelope { challenge, prfSalt }
    // under the same Redis key. Default to a v1-style envelope (NULL prfSalt)
    // so existing tests retain their legacy behavior.
    mockRedisGetdel.mockResolvedValue(
      JSON.stringify({ challenge: "test-challenge", prfSalt: null }),
    );
    mockVerifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: mockRegistrationInfo,
    });
    // Realistic default: the tenant relation is populated (User.tenantId is a
    // non-null FK, so Prisma always joins the row) with requireMinPinLength
    // unset (null) — the common "no PIN policy" case. A null tenant RELATION is
    // reserved for the data-corruption regression test below.
    mockPrismaUserFindUnique.mockResolvedValue({
      tenantId: "tenant-1",
      locale: "ja",
      tenant: { requireMinPinLength: null },
    });
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

      // T5 (v11 shape regression guard): assert the persisted credentialId comes
      // verbatim from registrationInfo.credential.id (string) — NOT from a
      // re-conversion of credentialPublicKey. And confirm publicKey is the
      // base64url of the publicKey Uint8Array.
      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            discoverable: true,
            credentialId: "AQID",
            publicKey: Buffer.from(new Uint8Array([4, 5, 6])).toString("base64url"),
            counter: 0n,
          }),
        }),
      );
      // T8: v11 calls uint8ArrayToBase64url exactly once per registration
      // (only for publicKey — credentialId is already a string and skips the
      // conversion).
      expect(mockUint8ArrayToBase64url).toHaveBeenCalledTimes(1);
      expect(mockUint8ArrayToBase64url).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]));
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

  it("fails closed (503, no mutation) when Redis rate-limit check errors", async () => {
    await assertRedisFailClosed({
      invoke: () => POST(createRequest("POST", ROUTE_URL, { body: makeBody() })),
      limiter: rateLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockRedisGetdel, mockPrismaCredentialCreate, mockSendEmail],
      limiterFactory: rateLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // ── Transport allowlist ──────────────────────────────────

  describe("transport allowlist", () => {
    it("filters out invalid transport values", async () => {
      const response = makeResponse();
      response.response.transports = ["internal", "invalid-transport", "usb"];
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: { response, nickname: "Test" },
      });
      await POST(req);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transports: ["internal", "usb"] }),
        }),
      );
    });

    it("returns empty array when no transports reported", async () => {
      const response = makeResponse();
      delete response.response.transports;
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: { response, nickname: "Test" },
      });
      await POST(req);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transports: [] }),
        }),
      );
    });
  });

  it("returns 400 with INVALID_CHALLENGE when challenge has expired", async () => {
    mockRedisGetdel.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_CHALLENGE");
  });

  it("consumes the challenge under the per-flow challengeId key (no cross-flow collision)", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
    await POST(req);

    // The key MUST embed both userId (scoping) and the per-flow challengeId so a
    // concurrent register flow from the same user cannot consume this challenge.
    expect(mockRedisGetdel).toHaveBeenCalledWith(
      `webauthn:challenge:register:user-1:${CHALLENGE_ID}`,
    );
  });

  it("returns 503 with SERVICE_UNAVAILABLE when WEBAUTHN_RP_ID is not set", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "");

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(503);
    expect(json.error).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 400 with VALIDATION_ERROR when verifyRegistration throws", async () => {
    mockVerifyRegistration.mockRejectedValue(new Error("fail"));

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 with VALIDATION_ERROR when verified is false", async () => {
    mockVerifyRegistration.mockResolvedValue({
      verified: false,
      registrationInfo: undefined,
    });

    const req = createRequest("POST", ROUTE_URL, {
      body: makeBody(),
    });
    const { status, json } = await parseResponse(await POST(req));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("persists PRF data when prfSupported credential is registered", async () => {
    const prfCredential = {
      ...makeCreatedCredential(true),
      prfSupported: true,
    };
    mockPrismaCredentialCreate.mockResolvedValue(prfCredential);

    const req = createRequest("POST", ROUTE_URL, {
      body: {
        ...makeBody({ credProps: { rk: true } }),
        prfEncryptedSecretKey: "encrypted-secret-key",
        prfSecretKeyIv: "prf-iv",
        prfSecretKeyAuthTag: "prf-auth-tag",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prfSupported: true,
          prfEncryptedSecretKey: "encrypted-secret-key",
          prfSecretKeyIv: "prf-iv",
          prfSecretKeyAuthTag: "prf-auth-tag",
          // A02-8: when the Redis envelope has `prfSalt: null` (default),
          // the route persists `prfSalt: null` (v1 legacy path).
          prfSalt: null,
        }),
      }),
    );
  });

  // ── A02-8: per-credential salt persistence + envelope handling ────────

  describe("A02-8 per-credential salt", () => {
    it("(T02) persists prfSalt from the Redis envelope when wrap fields are present", async () => {
      const PER_CRED_SALT = "a".repeat(64);
      mockRedisGetdel.mockResolvedValue(
        JSON.stringify({ challenge: "test-challenge", prfSalt: PER_CRED_SALT }),
      );
      const prfCredential = {
        ...makeCreatedCredential(true),
        prfSupported: true,
      };
      mockPrismaCredentialCreate.mockResolvedValue(prfCredential);

      const req = createRequest("POST", ROUTE_URL, {
        body: {
          ...makeBody({ credProps: { rk: true } }),
          prfEncryptedSecretKey: "encrypted",
          prfSecretKeyIv: "iv",
          prfSecretKeyAuthTag: "tag",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      // The new credential row carries the exact prfSalt from the envelope.
      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prfSalt: PER_CRED_SALT }),
        }),
      );
    });

    it("(T02) does NOT persist prfSalt when the request has no PRF wrap fields", async () => {
      // hasPrf is false → prfSalt: null even if envelope has one.
      const PER_CRED_SALT = "a".repeat(64);
      mockRedisGetdel.mockResolvedValue(
        JSON.stringify({ challenge: "test-challenge", prfSalt: PER_CRED_SALT }),
      );
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
      await POST(req);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prfSalt: null }),
        }),
      );
    });

    it("(T03) returns INVALID_CHALLENGE on legacy plain-string Redis value (mid-deploy migration window)", async () => {
      // Pre-A02-8 register-options stored a plain string. Post-A02-8 verify
      // sees it as non-JSON → fails-safe.
      mockRedisGetdel.mockResolvedValue("not-json-just-a-string");

      const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(400);
      expect(json.error).toBe("INVALID_CHALLENGE");
    });

    it("(S1) returns INVALID_CHALLENGE on a JSON-valid envelope with the wrong shape", async () => {
      // S1 defense-in-depth: JSON.parse("123") / "null" / "[]" succeeds but
      // does not match the envelope shape → must reject.
      mockRedisGetdel.mockResolvedValue("[]");

      const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(400);
      expect(json.error).toBe("INVALID_CHALLENGE");
    });

    it("(T04) returns VALIDATION_ERROR when the envelope's prfSalt is non-hex (tampered Redis)", async () => {
      mockRedisGetdel.mockResolvedValue(
        JSON.stringify({ challenge: "test-challenge", prfSalt: "z".repeat(64) }),
      );

      const req = createRequest("POST", ROUTE_URL, {
        body: {
          ...makeBody(),
          prfEncryptedSecretKey: "encrypted",
          prfSecretKeyIv: "iv",
          prfSecretKeyAuthTag: "tag",
        },
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(400);
      expect(json.error).toBe("VALIDATION_ERROR");
      // No credential row created.
      expect(mockPrismaCredentialCreate).not.toHaveBeenCalled();
    });

    it("(T05 / RT4) race condition: second verify with a consumed envelope fails with INVALID_CHALLENGE", async () => {
      // Two concurrent register/options requests: the second tab's set
      // overwrote the first's, and then THIS verify (the first tab's) hits a
      // Redis getdel that returns null (the second tab already consumed it
      // OR the entry expired). Either way, no row created — no silent brick.
      mockRedisGetdel.mockResolvedValue(null);

      const req = createRequest("POST", ROUTE_URL, { body: makeBody() });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(400);
      expect(json.error).toBe("INVALID_CHALLENGE");
      expect(mockPrismaCredentialCreate).not.toHaveBeenCalled();
    });
  });

  // ── minPinLength extraction tests ───────────────────────────

  describe("minPinLength extraction", () => {
    it("passes minPinLength=6 to Prisma when valid integer", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 6 }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minPinLength: 6 }),
        }),
      );
    });

    it("passes minPinLength=null when value is out of range (3, one below min boundary)", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 3 }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minPinLength: null }),
        }),
      );
    });

    it("passes minPinLength=4 when value is at exact lower boundary", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 4 }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minPinLength: 4 }),
        }),
      );
    });

    it("passes minPinLength=null when value is non-integer string", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: "4" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minPinLength: null }),
        }),
      );
    });

    it("passes minPinLength=null when not reported", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ minPinLength: null }),
        }),
      );
    });
  });

  // ── largeBlob extraction tests ───────────────────────────────

  describe("largeBlob extraction", () => {
    it("passes largeBlobSupported=true when supported", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ largeBlob: { supported: true } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ largeBlobSupported: true }),
        }),
      );
    });

    it("passes largeBlobSupported=false when not supported", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ largeBlob: { supported: false } }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ largeBlobSupported: false }),
        }),
      );
    });

    it("passes largeBlobSupported=null when not reported", async () => {
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);

      expect(mockPrismaCredentialCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ largeBlobSupported: null }),
        }),
      );
    });
  });

  // ── Tenant PIN policy tests ──────────────────────────────────

  describe("tenant PIN policy", () => {
    it("rejects registration when minPinLength < requireMinPinLength", async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        tenantId: "tenant-1",
        locale: "ja",
        tenant: { requireMinPinLength: 6 },
      });

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 4 }),
      });
      const { status, json } = await parseResponse(await POST(req));

      expect(status).toBe(400);
      expect(json.error).toBe("PIN_LENGTH_POLICY_NOT_SATISFIED");
    });

    it("allows registration when minPinLength not reported (platform authenticator)", async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        tenantId: "tenant-1",
        locale: "ja",
        tenant: { requireMinPinLength: 6 },
      });
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({}),
      });
      const res = await POST(req);

      expect(res.status).toBe(201);
    });

    it("allows registration when minPinLength equals requireMinPinLength", async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        tenantId: "tenant-1",
        locale: "ja",
        tenant: { requireMinPinLength: 6 },
      });
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 6 }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
    });

    it("allows registration when no policy set", async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        tenantId: "tenant-1",
        locale: "ja",
        tenant: { requireMinPinLength: null },
      });
      mockPrismaCredentialCreate.mockResolvedValue(makeCreatedCredential(null));

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 4 }),
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
    });

    // Regression (null-tenant fail-open class): userInfo.tenantId is a non-null
    // FK, so a null tenant RELATION is data corruption, NOT "no policy". Reading
    // `tenant?.requireMinPinLength ?? null` on a vanished tenant would silently
    // skip the PIN-length gate, letting a short-PIN authenticator register under
    // a tenant that required a longer PIN. Must FAIL CLOSED (throw → no credential).
    // Mutation check: restore `tenant?.… ?? null` (no null-relation throw) and a
    // sub-min-PIN registration succeeds instead of throwing — this test fails.
    it("fails closed (throws) when the tenant relation is missing (corruption)", async () => {
      mockPrismaUserFindUnique.mockResolvedValue({
        tenantId: "tenant-gone",
        locale: "ja",
        tenant: null,
      });

      const req = createRequest("POST", ROUTE_URL, {
        body: makeBody({ minPinLength: 4 }),
      });
      await expect(POST(req)).rejects.toThrow(/tenant-gone not found/);
      expect(mockPrismaCredentialCreate).not.toHaveBeenCalled();
    });
  });
});
