import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuthOrToken,
  mockBuildOpenApiSpec,
  mockWithUserTenantRls,
  mockDerivePasskeyState,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockAuthOrToken: vi.fn(),
  mockBuildOpenApiSpec: vi.fn().mockReturnValue({
    openapi: "3.1.0",
    info: { title: "passwd-sso API", version: "1" },
    paths: {},
  }),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: (tenantId: string) => unknown) => fn("tenant-1"),
  ),
  mockDerivePasskeyState: vi.fn(),
  mockLogAuditAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/session/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/openapi-spec", () => ({
  buildOpenApiSpec: mockBuildOpenApiSpec,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId }),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { GET } from "./route";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";

describe("GET /api/v1/openapi.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetPasskeyAuditForTests();
    // Default: public mode (no auth required). Empty string is not "false",
    // so the route treats it as public.
    vi.stubEnv("OPENAPI_PUBLIC", "");
    // Canonical origin configured — the servers[] host derives from it and the
    // response is public-cacheable. Tests that exercise the no-origin fallback
    // override this locally.
    vi.stubEnv("APP_URL", "https://api.example.test");
    vi.stubEnv("AUTH_URL", "https://api.example.test");
    mockWithUserTenantRls.mockImplementation(
      async (_userId: string, fn: (tenantId: string) => unknown) => fn("tenant-1"),
    );
    // Default: passkey enforcement off (does not block).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  it("returns OpenAPI spec without auth when OPENAPI_PUBLIC is not 'false'", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
    expect(mockAuthOrToken).not.toHaveBeenCalled();
  });

  it("sets public cache headers when OPENAPI_PUBLIC is not 'false'", async () => {
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("Vary")).toBe("Authorization");
  });

  it("returns 401 when OPENAPI_PUBLIC=false and unauthenticated", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  // C8: authOrToken's passkey_required variant is distinguished from a plain
  // `null` (unauthenticated) — before this branch the route checked only
  // `!result`, so the variant would have passed silently as "authenticated".
  it("returns 403 PASSKEY_REQUIRED when OPENAPI_PUBLIC=false and the bearer validator refuses for a missing passkey", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ type: "passkey_required" });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("PASSKEY_REQUIRED");
  });

  it("returns spec when OPENAPI_PUBLIC=false and authenticated", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
  });

  it("sets private cache headers when OPENAPI_PUBLIC=false", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  // #959 S7: openapi.json is an early-return route (never reaches the proxy's
  // session passkey gate), so a session result re-derives the block itself.
  it("returns 403 PASSKEY_REQUIRED when a blocked member authenticates via session", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("PASSKEY_REQUIRED");
    expect(mockBuildOpenApiSpec).not.toHaveBeenCalled();
    // Audited once, under the session's resolved tenant.
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync.mock.calls[0][0]).toMatchObject({
      action: "PASSKEY_ENFORCEMENT_BLOCKED",
      tenantId: "tenant-1",
      metadata: { blockedPath: "/api/v1/openapi.json" },
    });
  });

  it("returns spec for a session result when the tenant's passkey requirement does not block", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ type: "session", userId: "user-1" });
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: true,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("derives baseUrl from the configured origin, not the request Host", async () => {
    // Request arrives on an internal/attacker-controllable host; the spec must
    // still advertise the canonical configured origin, never the request host.
    const req = createRequest("GET", "http://attacker.evil/api/v1/openapi.json");
    await GET(req);
    expect(mockBuildOpenApiSpec).toHaveBeenCalledWith("https://api.example.test");
  });

  it("falls back to no-store (not public cache) when no origin is configured", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    // Host came from the request → must not be public-cached (poisoning guard).
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockBuildOpenApiSpec).toHaveBeenCalledWith("http://localhost:3000");
  });
});
