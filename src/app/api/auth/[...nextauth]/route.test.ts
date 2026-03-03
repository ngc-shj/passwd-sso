import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies so route.ts can be imported without side-effects
vi.mock("@/auth", () => ({
  handlers: {
    GET: vi.fn(async (req: NextRequest) => new Response(req.url)),
    POST: vi.fn(async (req: NextRequest) => new Response(req.url)),
  },
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: <T>(h: T) => h,
}));
vi.mock("@/lib/audit", () => ({
  extractRequestMeta: () => ({}),
}));
vi.mock("@/lib/session-meta", () => ({
  sessionMetaStorage: { run: (_meta: unknown, fn: () => unknown) => fn() },
}));

describe("withAuthBasePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("passes through unchanged when basePath is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    // When basePath is empty, the wrapper returns the handler itself
    expect(wrapped).toBe(inner);
  });

  it("prepends basePath to request pathname", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    const req = new NextRequest("http://localhost:3000/api/auth/signin");
    await wrapped(req);

    const patchedUrl = inner.mock.calls[0][0].url;
    expect(new URL(patchedUrl).pathname).toBe("/passwd-sso/api/auth/signin");
  });

  it("does not double-prefix when basePath is already present", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    // Simulate a request that already has basePath
    const req = new NextRequest(
      "http://localhost:3000/passwd-sso/api/auth/callback/google",
    );
    await wrapped(req);

    const patchedUrl = inner.mock.calls[0][0].url;
    expect(new URL(patchedUrl).pathname).toBe(
      "/passwd-sso/api/auth/callback/google",
    );
  });

  it("preserves query parameters", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { _withAuthBasePath } = await import(
      "@/app/api/auth/[...nextauth]/route"
    );

    const inner = vi.fn(async (req: NextRequest) => new Response(req.url));
    const wrapped = _withAuthBasePath(inner);

    const req = new NextRequest(
      "http://localhost:3000/api/auth/signin?callbackUrl=%2Fdashboard",
    );
    await wrapped(req);

    const patchedUrl = new URL(inner.mock.calls[0][0].url);
    expect(patchedUrl.pathname).toBe("/passwd-sso/api/auth/signin");
    expect(patchedUrl.searchParams.get("callbackUrl")).toBe("/dashboard");
  });
});
