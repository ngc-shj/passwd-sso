// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * BASE_PATH is evaluated at module load time from process.env.NEXT_PUBLIC_BASE_PATH.
 * We use vi.resetModules() + dynamic import to re-evaluate the constant per describe block.
 */

// ─── No basePath (default) ──────────────────────────────────

describe("url-helpers (no basePath)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("BASE_PATH defaults to empty string", async () => {
    const { BASE_PATH } = await import("@/lib/url-helpers");
    expect(BASE_PATH).toBe("");
  });

  it("withBasePath returns the path unchanged", async () => {
    const { withBasePath } = await import("@/lib/url-helpers");
    expect(withBasePath("/api/vault/status")).toBe("/api/vault/status");
  });

  it("fetchApi calls fetch with the original path", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { fetchApi } = await import("@/lib/url-helpers");

    await fetchApi("/api/passwords", { method: "GET" });

    expect(spy).toHaveBeenCalledWith("/api/passwords", { method: "GET" });
  });

  it("fetchApi passes through RequestInit options", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { fetchApi } = await import("@/lib/url-helpers");
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test" }),
    };

    await fetchApi("/api/passwords", init);

    expect(spy).toHaveBeenCalledWith("/api/passwords", init);
  });

  it("fetchApi calls fetch without init when init is omitted", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { fetchApi } = await import("@/lib/url-helpers");

    await fetchApi("/api/passwords");

    expect(spy).toHaveBeenCalledWith("/api/passwords");
  });

  it("withBasePath warns when path does not start with /", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { withBasePath } = await import("@/lib/url-helpers");

    withBasePath("api/test");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('path should start with "/"'),
    );
  });

  it("appUrl returns origin + path without basePath", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { origin: "https://example.com" },
      writable: true,
      configurable: true,
    });
    const { appUrl } = await import("@/lib/url-helpers");

    expect(appUrl("/dashboard")).toBe("https://example.com/dashboard");

    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });
});

// ─── With basePath="/passwd-sso" ────────────────────────────

describe("url-helpers (basePath=/passwd-sso)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("BASE_PATH equals /passwd-sso", async () => {
    const { BASE_PATH } = await import("@/lib/url-helpers");
    expect(BASE_PATH).toBe("/passwd-sso");
  });

  it("withBasePath prepends basePath to path", async () => {
    const { withBasePath } = await import("@/lib/url-helpers");
    expect(withBasePath("/api/vault/status")).toBe(
      "/passwd-sso/api/vault/status",
    );
  });

  it("withBasePath handles root path", async () => {
    const { withBasePath } = await import("@/lib/url-helpers");
    expect(withBasePath("/")).toBe("/passwd-sso/");
  });

  it("fetchApi calls fetch with basePath prepended", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { fetchApi } = await import("@/lib/url-helpers");

    await fetchApi("/api/passwords");

    expect(spy).toHaveBeenCalledWith("/passwd-sso/api/passwords");
  });

  it("fetchApi forwards RequestInit when basePath is set", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const { fetchApi } = await import("@/lib/url-helpers");
    const init: RequestInit = { method: "DELETE" };

    await fetchApi("/api/passwords/abc", init);

    expect(spy).toHaveBeenCalledWith("/passwd-sso/api/passwords/abc", init);
  });

  it("appUrl returns origin + basePath + path", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com" },
      writable: true,
      configurable: true,
    });
    const { appUrl } = await import("@/lib/url-helpers");

    expect(appUrl("/dashboard")).toBe(
      "https://app.example.com/passwd-sso/dashboard",
    );

    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("appUrl builds correct URL for root path", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com" },
      writable: true,
      configurable: true,
    });
    const { appUrl } = await import("@/lib/url-helpers");

    expect(appUrl("/")).toBe("https://app.example.com/passwd-sso/");

    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });
});

// ─── serverAppUrl ────────────────────────────────────────────

describe("serverAppUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns APP_URL + path when APP_URL is set", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    const { serverAppUrl } = await import("@/lib/url-helpers");
    expect(serverAppUrl("/reset")).toBe("https://app.example.com/reset");
  });

  it("falls back to AUTH_URL when APP_URL is not set", async () => {
    delete process.env.APP_URL;
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { serverAppUrl } = await import("@/lib/url-helpers");
    expect(serverAppUrl("/reset")).toBe("https://auth.example.com/reset");
  });

  it("returns empty origin when both APP_URL and AUTH_URL are unset", async () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const { serverAppUrl } = await import("@/lib/url-helpers");
    expect(serverAppUrl("/reset")).toBe("/reset");
  });

  it("combines APP_URL with NEXT_PUBLIC_BASE_PATH", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { serverAppUrl } = await import("@/lib/url-helpers");
    expect(serverAppUrl("/dashboard")).toBe(
      "https://app.example.com/passwd-sso/dashboard",
    );
  });

  it("prefers APP_URL over AUTH_URL when both are set", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { serverAppUrl } = await import("@/lib/url-helpers");
    expect(serverAppUrl("/reset")).toBe("https://app.example.com/reset");
  });
});
