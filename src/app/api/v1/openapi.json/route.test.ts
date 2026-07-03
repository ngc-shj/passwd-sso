import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuthOrToken, mockBuildOpenApiSpec } = vi.hoisted(() => ({
  mockAuthOrToken: vi.fn(),
  mockBuildOpenApiSpec: vi.fn().mockReturnValue({
    openapi: "3.1.0",
    info: { title: "passwd-sso API", version: "1" },
    paths: {},
  }),
}));

vi.mock("@/lib/auth/session/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));
vi.mock("@/lib/openapi-spec", () => ({
  buildOpenApiSpec: mockBuildOpenApiSpec,
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

describe("GET /api/v1/openapi.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Default: public mode (no auth required). Empty string is not "false",
    // so the route treats it as public.
    vi.stubEnv("OPENAPI_PUBLIC", "");
    // Canonical origin configured — the servers[] host derives from it and the
    // response is public-cacheable. Tests that exercise the no-origin fallback
    // override this locally.
    vi.stubEnv("APP_URL", "https://api.example.test");
    vi.stubEnv("AUTH_URL", "https://api.example.test");
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

  it("returns spec when OPENAPI_PUBLIC=false and authenticated", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ userId: "user-1" });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe("3.1.0");
  });

  it("sets private cache headers when OPENAPI_PUBLIC=false", async () => {
    vi.stubEnv("OPENAPI_PUBLIC", "false");
    mockAuthOrToken.mockResolvedValue({ userId: "user-1" });
    const req = createRequest("GET", "http://localhost:3000/api/v1/openapi.json");
    const res = await GET(req);
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
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
