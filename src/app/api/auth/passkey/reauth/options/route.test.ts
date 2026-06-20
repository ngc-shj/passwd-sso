import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockAssertOrigin,
  mockRateLimiterCheck,
  mockRedisSet,
  mockFindMany,
  mockGenerateAuthenticationOpts,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAssertOrigin: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockRedisSet: vi.fn(),
  mockFindMany: vi.fn(),
  mockGenerateAuthenticationOpts: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/auth/session/csrf", () => ({
  assertOrigin: mockAssertOrigin,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: mockRedisSet }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: {
      findMany: mockFindMany,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

// A02-8: route now calls buildPrfExtensions; mock follows the same v1/v2
// convention used in other PRF-options test files.
vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  buildPrfExtensions: vi.fn(
    (creds: Array<{ credentialId: string; prfSalt: string | null }>) => {
      const hasV1 = creds.length === 0 || creds.some((c) => c.prfSalt === null);
      const hasV2 = creds.some((c) => c.prfSalt !== null);
      const result: { eval?: { first: string }; evalByCredential?: Record<string, { first: string }> } = {};
      if (hasV1) result.eval = { first: "a".repeat(64) };
      if (hasV2) {
        result.evalByCredential = {};
        for (const c of creds) {
          if (c.prfSalt) result.evalByCredential[c.credentialId] = { first: c.prfSalt };
        }
      }
      return result;
    },
  ),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: 300,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

import { POST } from "./route";

const ROUTE_URL = "http://localhost:3000/api/auth/passkey/reauth/options";

describe("POST /api/auth/passkey/reauth/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAssertOrigin.mockReturnValue(null);
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockFindMany.mockResolvedValue([
      { credentialId: "cred-1", transports: ["internal"], prfSalt: null },
    ]);
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "challenge-1",
      rpId: "localhost",
    });
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) => fn(prisma),
    );
  });

  it("returns options and stores a dedicated reauth challenge", async () => {
    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.options.challenge).toBe("challenge-1");
    expect(json.challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^webauthn:challenge:reauth:user-1:[0-9a-f]{32}$/),
      "challenge-1",
      "EX",
      300,
    );
    // A02-8: the route strips `prfSalt` from the credentials list before
    // calling `generateAuthenticationOpts` (the underlying simplewebauthn
    // helper doesn't take it). `prfSalt` is still consulted by
    // `buildPrfExtensions` to choose v1 vs v2 PRF salt.
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith([
      { credentialId: "cred-1", transports: ["internal"] },
    ]);
  });

  it("returns 404 when the user has no passkey credentials", async () => {
    mockFindMany.mockResolvedValue([]);

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "NOT_FOUND" });
  });

  it("returns 401 when the request has no authenticated session", async  () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(res.status).toBe(401);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });

    const res = await POST(
      createRequest("POST", ROUTE_URL, {
        headers: { origin: "http://localhost:3000" },
      }),
    );

    expect(res.status).toBe(429);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  // ── A02-8: v1/v2/mixed PRF extension shape (T07/T09) ──────────────────

  describe("A02-8 PRF extension shape", () => {
    it("(T09 legacy) sends top-level eval only when every credential has NULL prfSalt", async () => {
      mockFindMany.mockResolvedValue([
        { credentialId: "cred-1", transports: ["internal"], prfSalt: null },
      ]);
      const res = await POST(
        createRequest("POST", ROUTE_URL, { headers: { origin: "http://localhost:3000" } }),
      );
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: { first?: string }; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval?.first).toBeDefined();
      expect(json.options.extensions?.prf?.evalByCredential).toBeUndefined();
    });

    it("(T07 all-v2) sends evalByCredential keyed by credential ids when prfSalt is set", async () => {
      mockFindMany.mockResolvedValue([
        { credentialId: "cred-A", transports: ["internal"], prfSalt: "a".repeat(64) },
      ]);
      const res = await POST(
        createRequest("POST", ROUTE_URL, { headers: { origin: "http://localhost:3000" } }),
      );
      const json = (await res.json()) as { options: { extensions?: { prf?: { eval?: unknown; evalByCredential?: Record<string, unknown> } } } };
      expect(res.status).toBe(200);
      expect(json.options.extensions?.prf?.eval).toBeUndefined();
      expect(json.options.extensions?.prf?.evalByCredential).toHaveProperty("cred-A");
    });
  });
});
