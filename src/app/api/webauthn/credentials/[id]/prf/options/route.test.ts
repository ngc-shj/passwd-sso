import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRateLimiterCheck,
  mockGetRedis,
  mockRedisSet,
  mockPrismaCredential,
  mockWithUserTenantRls,
  mockGenerateAuthenticationOpts,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimiterCheck: vi.fn(),
  mockGetRedis: vi.fn(),
  mockRedisSet: vi.fn(),
  mockPrismaCredential: { findFirst: vi.fn() },
  mockWithUserTenantRls: vi.fn(),
  mockGenerateAuthenticationOpts: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/prisma", () => ({
  prisma: { webAuthnCredential: mockPrismaCredential },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/webauthn/webauthn-server", () => ({
  generateAuthenticationOpts: mockGenerateAuthenticationOpts,
  WEBAUTHN_CHALLENGE_TTL_SECONDS: 300,
}));
vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { POST } from "./route";

const URL = "http://localhost:3000/api/webauthn/credentials/cred-row-1/prf/options";
const params = { params: Promise.resolve({ id: "cred-row-1" }) };

describe("POST /api/webauthn/credentials/[id]/prf/options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockGetRedis.mockReturnValue({ set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWithUserTenantRls.mockImplementation(async (_uid: string, fn: any) => fn());
    mockPrismaCredential.findFirst.mockResolvedValue({
      credentialId: "credential-id-base64url",
      transports: ["internal"],
    });
    mockGenerateAuthenticationOpts.mockResolvedValue({
      challenge: "fresh-challenge",
      allowCredentials: [{ id: "credential-id-base64url" }],
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(401);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(429);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("returns 503 when Redis unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(503);
  });

  it("returns 404 when credential not found / not owned by user", async () => {
    mockPrismaCredential.findFirst.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(404);
    expect(mockGenerateAuthenticationOpts).not.toHaveBeenCalled();
  });

  it("issues a challenge to the DEDICATED PRF Redis key (not the sign-in key)", async () => {
    const res = await POST(createRequest("POST", URL), params);
    expect(res.status).toBe(200);
    // Critical security invariant from #433/S-N1: the rebootstrap flow MUST
    // use a key namespace separate from sign-in's
    // `webauthn:challenge:authenticate:${userId}`. Mixing would let one flow
    // consume the other's challenge (race / DoS / replay).
    expect(mockRedisSet).toHaveBeenCalledWith(
      "webauthn:challenge:prf-rebootstrap:user-1",
      "fresh-challenge",
      "EX",
      300,
    );
  });

  it("restricts allowCredentials to the URL [id] credential only", async () => {
    await POST(createRequest("POST", URL), params);
    expect(mockGenerateAuthenticationOpts).toHaveBeenCalledWith([
      { credentialId: "credential-id-base64url", transports: ["internal"] },
    ]);
  });
});
