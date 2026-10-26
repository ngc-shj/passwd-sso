// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CLIENT_LOG_EVENT, opaque } from "@/lib/logger/client";

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

    // The path itself is deliberately NOT logged — it is caller-supplied and a
    // query string can carry a token. Only the leading segment is emitted.
    expect(warnSpy).toHaveBeenCalledWith(
      CLIENT_LOG_EVENT.BASE_PATH_MALFORMED,
      { firstSegment: opaque("api") },
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

// ─── hardNavigate ────────────────────────────────────────────

describe("hardNavigate", () => {
  const ORIGIN = "https://app.example.com";
  let location: { origin: string; href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    originalLocation = window.location;
    // jsdom refuses a real navigation ("Not implemented"), so href is a plain
    // writable property here — its value after the call IS the assertion.
    location = { origin: ORIGIN, href: `${ORIGIN}/dashboard` };
    Object.defineProperty(window, "location", {
      value: location,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("navigates to an absolute URL on the current origin", async () => {
    const { hardNavigate } = await import("@/lib/url-helpers");

    hardNavigate("/ja/dashboard");

    expect(location.href).toBe(`${ORIGIN}/ja/dashboard`);
  });

  it("preserves a percent-encoded query", async () => {
    const { hardNavigate } = await import("@/lib/url-helpers");

    hardNavigate(`/ja/auth/signin?callbackUrl=${encodeURIComponent("/ja/dashboard")}`);

    expect(location.href).toBe(`${ORIGIN}/ja/auth/signin?callbackUrl=%2Fja%2Fdashboard`);
  });

  it("prepends basePath before resolving", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const { hardNavigate } = await import("@/lib/url-helpers");

    hardNavigate("/ja/dashboard");

    expect(location.href).toBe(`${ORIGIN}/passwd-sso/ja/dashboard`);
  });

  it("refuses a protocol-relative destination and does not navigate", async () => {
    const { hardNavigate } = await import("@/lib/url-helpers");

    // With BASE_PATH empty this reaches location.href verbatim, and the browser
    // reads it as https://evil.example — an open redirect, not a broken path.
    expect(() => hardNavigate("//evil.example/steal")).toThrow(/https:\/\/evil\.example/);
    expect(location.href).toBe(`${ORIGIN}/dashboard`);
  });

  it("refuses a javascript: destination and does not navigate", async () => {
    const { hardNavigate } = await import("@/lib/url-helpers");

    expect(() => hardNavigate("javascript:alert(1)")).toThrow(/refusing to navigate/);
    expect(location.href).toBe(`${ORIGIN}/dashboard`);
  });

  it("refuses an absolute URL to another origin", async () => {
    const { hardNavigate } = await import("@/lib/url-helpers");

    expect(() => hardNavigate("https://evil.example/steal")).toThrow(/refusing to navigate/);
    expect(location.href).toBe(`${ORIGIN}/dashboard`);
  });
});

// ─── getAppOrigin ────────────────────────────────────────────

describe("getAppOrigin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns APP_URL when set", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { getAppOrigin } = await import("@/lib/url-helpers");
    expect(getAppOrigin()).toBe("https://app.example.com");
  });

  it("falls back to AUTH_URL when APP_URL is not set", async () => {
    delete process.env.APP_URL;
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { getAppOrigin } = await import("@/lib/url-helpers");
    expect(getAppOrigin()).toBe("https://auth.example.com");
  });

  it("returns undefined when neither is set", async () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const { getAppOrigin } = await import("@/lib/url-helpers");
    expect(getAppOrigin()).toBeUndefined();
  });

  it("falls back to AUTH_URL when APP_URL is empty string", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    const { getAppOrigin } = await import("@/lib/url-helpers");
    expect(getAppOrigin()).toBe("https://auth.example.com");
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

// ─── isHttps ──────────────────────────────────────────────────

describe("isHttps", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when AUTH_URL starts with https://", async () => {
    vi.stubEnv("AUTH_URL", "https://app.example.com");
    const { isHttps } = await import("@/lib/url-helpers");
    expect(isHttps).toBe(true);
  });

  it("returns false when AUTH_URL starts with http://", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const { isHttps } = await import("@/lib/url-helpers");
    expect(isHttps).toBe(false);
  });

  it("defaults to false when AUTH_URL is not set", async () => {
    delete process.env.AUTH_URL;
    const { isHttps } = await import("@/lib/url-helpers");
    expect(isHttps).toBe(false);
  });
});

// ─── resolveBasePath ────────────────────────────────────────
// Reads process.env at call time, so vi.stubEnv works without dynamic import.

describe("resolveBasePath", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses URL pathname when present (strips trailing slash)", async () => {
    const { resolveBasePath } = await import("@/lib/url-helpers");
    expect(resolveBasePath(new URL("https://example.com/passwd-sso"))).toBe("/passwd-sso");
    expect(resolveBasePath(new URL("https://example.com/passwd-sso/"))).toBe("/passwd-sso");
  });

  it("returns empty string when both URL pathname and env are empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const { resolveBasePath } = await import("@/lib/url-helpers");
    expect(resolveBasePath(new URL("https://example.com"))).toBe("");
  });

  it("falls back to NEXT_PUBLIC_BASE_PATH when URL pathname is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/from-env");
    const { resolveBasePath } = await import("@/lib/url-helpers");
    expect(resolveBasePath(new URL("https://example.com"))).toBe("/from-env");
    expect(resolveBasePath(new URL("https://example.com/"))).toBe("/from-env");
  });

  it("URL pathname takes precedence over env when both set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/from-env");
    const { resolveBasePath } = await import("@/lib/url-helpers");
    expect(resolveBasePath(new URL("https://example.com/from-url"))).toBe("/from-url");
  });

  it("multi-segment URL pathname is preserved", async () => {
    const { resolveBasePath } = await import("@/lib/url-helpers");
    expect(resolveBasePath(new URL("https://example.com/apps/passwd-sso"))).toBe("/apps/passwd-sso");
  });
});


// ─── fetchApi PASSKEY_REQUIRED reaction ──────────────────────

describe("fetchApi PASSKEY_REQUIRED reaction", () => {
  const ORIGIN = "https://app.example.com";
  let location: { origin: string; pathname: string; search: string; href: string };
  let originalLocation: Location;

  function placeAt(pathname: string) {
    location.pathname = pathname;
    location.href = `${ORIGIN}${pathname}`;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const passkeyRequired = () => jsonResponse(403, { error: "PASSKEY_REQUIRED" });

  async function loadHelpers() {
    const mod = await import("@/lib/url-helpers");
    mod._resetPasskeyRequiredReactionForTests();
    return mod;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    originalLocation = window.location;
    // jsdom refuses a real navigation, so href is a plain writable property —
    // its value after the call IS the navigation assertion.
    location = { origin: ORIGIN, pathname: "/", search: "", href: `${ORIGIN}/` };
    Object.defineProperty(window, "location", {
      value: location,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("navigates to the passkey page once per load under /dashboard", async () => {
    placeAt("/ja/dashboard/favorites");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi } = await loadHelpers();

    await fetchApi("/api/passwords");
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard/settings/auth/passkey`);

    // The latch: a second refusal on the same load does not navigate again.
    location.href = "sentinel";
    await fetchApi("/api/tags");
    expect(location.href).toBe("sentinel");
  });

  it("navigates under /admin, keeping the locale", async () => {
    placeAt("/en/admin/tenant/members");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi } = await loadHelpers();

    await fetchApi("/api/tenant/members");
    expect(location.href).toBe(`${ORIGIN}/en/dashboard/settings/auth/passkey`);
  });

  it.each([
    ["another 403 code", () => jsonResponse(403, { error: "FORBIDDEN" })],
    ["a 503 (degraded session)", () => jsonResponse(503, { error: "SERVICE_UNAVAILABLE" })],
    ["an unreadable 403 body", () => new Response("<html>not json</html>", { status: 403 })],
  ])("does not navigate on %s", async (_label, makeResponse) => {
    placeAt("/ja/dashboard");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => makeResponse());
    const { fetchApi } = await loadHelpers();

    await expect(fetchApi("/api/passwords")).resolves.toBeInstanceOf(Response);
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard`);
  });

  it.each(["/ja/auth/signin", "/ja/dashboards", "/en/vault-reset", "/"])(
    "does not bounce a page outside /dashboard and /admin (%s)",
    async (pathname) => {
      placeAt(pathname);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
      const { fetchApi } = await loadHelpers();

      await fetchApi("/api/passwords");
      expect(location.href).toBe(`${ORIGIN}${pathname}`);
    },
  );

  it("does not navigate while the passkey-required screen is mounted", async () => {
    placeAt("/ja/dashboard/settings/auth/passkey");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi, setPasskeyRequiredScreenMounted } = await loadHelpers();

    setPasskeyRequiredScreenMounted(true);
    await fetchApi("/api/passwords");
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard/settings/auth/passkey`);

    // Positive control: once the screen unmounts, the same refusal navigates.
    setPasskeyRequiredScreenMounted(false);
    location.href = "sentinel";
    await fetchApi("/api/passwords");
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard/settings/auth/passkey`);
  });

  it("on the passkey URL with the flag unset (a stale shell) navigates exactly once", async () => {
    placeAt("/ja/dashboard/settings/auth/passkey");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi } = await loadHelpers();

    const hrefWrites: string[] = [];
    let href = location.href;
    Object.defineProperty(location, "href", {
      get: () => href,
      set: (value: string) => {
        hrefWrites.push(value);
        href = value;
      },
      configurable: true,
    });

    await fetchApi("/api/passwords");
    await fetchApi("/api/tags");
    await fetchApi("/api/folders");

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(hrefWrites).toEqual([`${ORIGIN}/ja/dashboard/settings/auth/passkey`]);
  });

  it("returns the response unchanged: the caller can still read the body", async () => {
    placeAt("/ja/dashboard");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi } = await loadHelpers();

    const res = await fetchApi("/api/passwords");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REQUIRED" });
  });

  it("never throws on a plain-object 403 without clone()", async () => {
    placeAt("/ja/dashboard");
    const plain = { ok: false, status: 403, json: async () => ({ error: "PASSKEY_REQUIRED" }) };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => plain as unknown as Response,
    );
    const { fetchApi } = await loadHelpers();

    await expect(fetchApi("/api/passwords")).resolves.toBe(plain);
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard`);
  });

  it("strips and re-applies basePath", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    placeAt("/passwd-sso/en/dashboard/tags");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => passkeyRequired());
    const { fetchApi } = await loadHelpers();

    await fetchApi("/api/tags");
    expect(location.href).toBe(`${ORIGIN}/passwd-sso/en/dashboard/settings/auth/passkey`);
  });
});

// ─── currentAppPath ──────────────────────────────────────────

describe("currentAppPath", () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    originalLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.unstubAllEnvs();
  });

  function placeAt(pathname: string, search = "") {
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com", pathname, search },
      writable: true,
      configurable: true,
    });
  }

  it("returns the pathname and query without basePath", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    placeAt("/passwd-sso/ja/dashboard", "?q=1");
    const { currentAppPath } = await import("@/lib/url-helpers");
    expect(currentAppPath()).toBe("/ja/dashboard?q=1");
  });

  it("leaves a pathname that only shares a prefix with basePath alone", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    placeAt("/passwd-sso-other/ja");
    const { currentAppPath } = await import("@/lib/url-helpers");
    expect(currentAppPath()).toBe("/passwd-sso-other/ja");
  });

  it("returns the pathname unchanged with no basePath", async () => {
    placeAt("/en/admin");
    const { currentAppPath } = await import("@/lib/url-helpers");
    expect(currentAppPath()).toBe("/en/admin");
  });
});
