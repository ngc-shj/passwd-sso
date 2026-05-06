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

vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
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
      { credentialId: "cred-1", transports: ["internal"] },
    ]);
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "challenge-1",
      rpId: "localhost",
    });
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown) => fn(),
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
});
