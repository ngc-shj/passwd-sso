import { describe, it, expect, vi, beforeEach } from "vitest";
import { canonicalHtu, canonicalHtuClient, htuMatches } from "./htu-canonical";

beforeEach(() => {
  // Default: APP_URL set. Specific tests override via vi.stubEnv.
  vi.stubEnv("APP_URL", "https://example.com");
  vi.stubEnv("AUTH_URL", "");
});

describe("canonicalHtu", () => {
  it("returns scheme + host + path with no trailing slash injection", () => {
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("lowercases the scheme", () => {
    vi.stubEnv("APP_URL", "HTTPS://EXAMPLE.COM");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("lowercases the host", () => {
    vi.stubEnv("APP_URL", "https://Example.COM");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("strips default https port 443", () => {
    vi.stubEnv("APP_URL", "https://example.com:443");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com/api/foo");
  });

  it("strips default http port 80", () => {
    vi.stubEnv("APP_URL", "http://example.com:80");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("http://example.com/api/foo");
  });

  it("preserves non-default port", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("http://localhost:3000/api/foo");
  });

  it("preserves explicit non-default https port", () => {
    vi.stubEnv("APP_URL", "https://example.com:8443");
    expect(canonicalHtu({ route: "/api/foo" })).toBe("https://example.com:8443/api/foo");
  });

  it("normalizes a route missing leading slash", () => {
    expect(canonicalHtu({ route: "api/foo" })).toBe("https://example.com/api/foo");
  });

  it("falls back to AUTH_URL when APP_URL unset", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "https://auth.example.com");
    expect(canonicalHtu({ route: "/x" })).toBe("https://auth.example.com/x");
  });

  it("throws when neither APP_URL nor AUTH_URL is set", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("AUTH_URL", "");
    expect(() => canonicalHtu({ route: "/api/foo" })).toThrow(/APP_URL/);
  });

  // basePath-aware deployments — issue surfaced by the iOS host app, where
  // the client computes htu from the actual URL it called (which always
  // includes the basePath prefix, e.g. /passwd-sso). Without these the
  // server's canonicalHtu would strip the basePath and DPoP verification
  // would fail with "htu mismatch".

  it("preserves basePath from APP_URL pathname", () => {
    vi.stubEnv("APP_URL", "https://www.jpng.jp/passwd-sso");
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://www.jpng.jp/passwd-sso/api/mobile/token",
    );
  });

  it("preserves basePath even with trailing slash on APP_URL", () => {
    vi.stubEnv("APP_URL", "https://www.jpng.jp/passwd-sso/");
    expect(canonicalHtu({ route: "/api/mobile/token" })).toBe(
      "https://www.jpng.jp/passwd-sso/api/mobile/token",
    );
  });

  it("supports multi-segment basePath", () => {
    vi.stubEnv("APP_URL", "https://example.com/apps/passwd-sso");
    expect(canonicalHtu({ route: "/api/mobile/token/refresh" })).toBe(
      "https://example.com/apps/passwd-sso/api/mobile/token/refresh",
    );
  });

  // Deployments that put the sub-path in NEXT_PUBLIC_BASE_PATH instead of
  // APP_URL/AUTH_URL — e.g., AUTH_URL=https://example.com, NEXT_PUBLIC_BASE_PATH=/passwd-sso.
  // The request URL the browser actually called includes the basePath; htu must too.
  it("falls back to NEXT_PUBLIC_BASE_PATH when APP_URL has no basePath", () => {
    vi.stubEnv("APP_URL", "https://example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    expect(canonicalHtu({ route: "/api/extension/token/exchange" })).toBe(
      "https://example.com/passwd-sso/api/extension/token/exchange",
    );
  });

  it("prefers APP_URL pathname over NEXT_PUBLIC_BASE_PATH when both set", () => {
    vi.stubEnv("APP_URL", "https://example.com/from-url");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/from-env"); // ignored
    expect(canonicalHtu({ route: "/api/x" })).toBe(
      "https://example.com/from-url/api/x",
    );
  });
});

describe("htuMatches", () => {
  it("returns true when both inputs are identical canonical URLs", () => {
    expect(htuMatches("https://a.test/x", "https://a.test/x")).toBe(true);
  });

  it("scheme comparison is case-insensitive", () => {
    expect(htuMatches("HTTPS://a.test/x", "https://a.test/x")).toBe(true);
  });

  it("host comparison is case-insensitive", () => {
    expect(htuMatches("https://A.test/x", "https://a.test/x")).toBe(true);
  });

  it("path comparison is case-sensitive", () => {
    expect(htuMatches("https://a.test/X", "https://a.test/x")).toBe(false);
  });

  it("treats default port and elided port as equal (https:443)", () => {
    expect(htuMatches("https://a.test:443/x", "https://a.test/x")).toBe(true);
  });

  it("treats default http port 80 and elided port as equal", () => {
    expect(htuMatches("http://a.test:80/x", "http://a.test/x")).toBe(true);
  });

  it("rejects mismatched non-default ports", () => {
    expect(htuMatches("https://a.test:8443/x", "https://a.test/x")).toBe(false);
  });

  it("rejects mismatched scheme even when host+path match", () => {
    expect(htuMatches("http://a.test/x", "https://a.test/x")).toBe(false);
  });

  it("rejects mismatched host", () => {
    expect(htuMatches("https://b.test/x", "https://a.test/x")).toBe(false);
  });

  it("rejects when provided contains a query string", () => {
    expect(htuMatches("https://a.test/x?y=1", "https://a.test/x")).toBe(false);
  });

  it("rejects when provided contains a fragment", () => {
    expect(htuMatches("https://a.test/x#frag", "https://a.test/x")).toBe(false);
  });

  it("returns false on malformed input rather than throwing", () => {
    expect(htuMatches("not a url", "https://a.test/x")).toBe(false);
    expect(htuMatches("https://a.test/x", "not a url")).toBe(false);
  });

  it("matches when basePath is identical on both sides", () => {
    expect(
      htuMatches(
        "https://www.jpng.jp/passwd-sso/api/mobile/token",
        "https://www.jpng.jp/passwd-sso/api/mobile/token",
      ),
    ).toBe(true);
  });

  it("differs when basePath differs", () => {
    expect(
      htuMatches(
        "https://www.jpng.jp/api/mobile/token",
        "https://www.jpng.jp/passwd-sso/api/mobile/token",
      ),
    ).toBe(false);
  });
});

describe("canonicalHtuClient", () => {
  it("basic URL — strips default port and produces origin+route", () => {
    expect(canonicalHtuClient("https://example.com", "/api/foo")).toBe(
      "https://example.com/api/foo",
    );
  });

  it("lowercases scheme and host (URL.origin behavior)", () => {
    expect(canonicalHtuClient("HTTPS://EXAMPLE.COM", "/api/foo")).toBe(
      "https://example.com/api/foo",
    );
  });

  it("strips default https port 443", () => {
    expect(canonicalHtuClient("https://example.com:443", "/api/foo")).toBe(
      "https://example.com/api/foo",
    );
  });

  it("strips default http port 80", () => {
    expect(canonicalHtuClient("http://example.com:80", "/api/foo")).toBe(
      "http://example.com/api/foo",
    );
  });

  it("preserves non-default port", () => {
    expect(canonicalHtuClient("http://localhost:3000", "/api/foo")).toBe(
      "http://localhost:3000/api/foo",
    );
  });

  it("preserves basePath (no trailing slash)", () => {
    expect(
      canonicalHtuClient("https://example.com/passwd-sso", "/api/extension/token/exchange"),
    ).toBe("https://example.com/passwd-sso/api/extension/token/exchange");
  });

  it("strips trailing slash from serverUrl before appending route", () => {
    expect(
      canonicalHtuClient("https://example.com/passwd-sso/", "/api/x"),
    ).toBe("https://example.com/passwd-sso/api/x");
  });

  it("adds leading slash to route when missing", () => {
    expect(canonicalHtuClient("https://example.com", "api/foo")).toBe(
      "https://example.com/api/foo",
    );
  });
});

// ─── canonicalHtuClient vs canonicalHtu equivalence smoke tests ──────────────
//
// Per plan §C-shared / Round-3 S23-r3: both functions MUST produce identical
// htu strings when serverUrl === APP_URL (including basePath deployments).
// Regression here means the extension's DPoP proofs will fail on the server.

describe("canonicalHtuClient === canonicalHtu equivalence", () => {
  it.each([
    {
      label: "plain domain (no basePath)",
      serverUrl: "https://example.com",
      route: "/api/extension/token/exchange",
      appOrigin: "https://example.com",
    },
    {
      label: "uppercase scheme+host in serverUrl",
      serverUrl: "HTTPS://EXAMPLE.COM",
      route: "/api/x",
      appOrigin: "https://example.com",
    },
    {
      label: "default port 443 present in serverUrl",
      serverUrl: "https://example.com:443",
      route: "/api/x",
      appOrigin: "https://example.com",
    },
    {
      label: "trailing slash on serverUrl",
      serverUrl: "https://example.com/",
      route: "/api/x",
      appOrigin: "https://example.com",
    },
    {
      label: "basePath-bearing serverUrl (S23-r3 critical case)",
      serverUrl: "https://example.com/passwd-sso",
      route: "/api/x",
      appOrigin: "https://example.com/passwd-sso",
    },
    {
      label: "basePath with trailing slash on serverUrl",
      serverUrl: "https://example.com/passwd-sso/",
      route: "/api/x",
      appOrigin: "https://example.com/passwd-sso",
    },
    {
      label: "multi-segment basePath",
      serverUrl: "https://example.com/apps/passwd-sso",
      route: "/api/mobile/token/refresh",
      appOrigin: "https://example.com/apps/passwd-sso",
    },
  ])(
    "$label",
    ({ serverUrl, route, appOrigin }) => {
      vi.stubEnv("APP_URL", appOrigin);
      vi.stubEnv("AUTH_URL", "");
      const serverResult = canonicalHtu({ route });
      const clientResult = canonicalHtuClient(serverUrl, route);
      expect(clientResult).toBe(serverResult);
    },
  );
});
