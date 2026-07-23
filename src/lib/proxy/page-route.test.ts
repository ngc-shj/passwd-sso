import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockCheckAccessWithAudit, mockResolveUserTenantId, mockIntlMiddleware } =
  vi.hoisted(() => ({
    mockCheckAccessWithAudit: vi.fn().mockResolvedValue({ allowed: true }),
    mockResolveUserTenantId: vi.fn().mockResolvedValue(null),
    // next-intl/middleware default export factory; we always return 200 here
    // so handlePageRoute proceeds past the redirect-shortcut.
    mockIntlMiddleware: vi.fn(),
  }));

vi.mock("next-intl/middleware", async () => {
  const { NextResponse: NR } = await import("next/server");
  // Configure default behavior: returns 200.
  mockIntlMiddleware.mockImplementation(() => new NR(null, { status: 200 }));
  return { default: () => mockIntlMiddleware };
});
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessWithAudit,
}));
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));
vi.mock("@/lib/auth/session/session-cache", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/session/session-cache")
  >("@/lib/auth/session/session-cache");
  return {
    ...actual,
    getCachedSession: vi.fn().mockResolvedValue(null),
    setCachedSession: vi.fn().mockResolvedValue(undefined),
    invalidateCachedSession: vi.fn().mockResolvedValue(undefined),
  };
});

import { handlePageRoute } from "./page-route";
import {
  recordPasskeyAuditEmit,
  PASSKEY_AUDIT_DEDUP_MS,
  PASSKEY_AUDIT_MAP_MAX,
  _resetPasskeyAuditForTests,
  _passkeyAuditSizeForTests,
  _passkeyAuditHasForTests,
  _passkeyAuditFirstKeyForTests,
} from "../auth/policy/passkey-enforcement";

const APP_ORIGIN = "http://localhost:3000";
const dummyOptions = { cspHeader: "default-src 'self'", nonce: "test-nonce" };

function makePageRequest(
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, { headers });
}

type SessionUserOverrides = {
  id?: string;
  hasPasskey?: boolean;
  requirePasskey?: boolean;
  requirePasskeyEnabledAt?: string | null;
  passkeyGracePeriodDays?: number | null;
};

function mockValidSession(fetchSpy: ReturnType<typeof vi.spyOn>, user: SessionUserOverrides = {}) {
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({
        user: { id: "u-1", ...user },
        expires: new Date(Date.now() + 60_000).toISOString(),
      }),
      { status: 200 },
    ),
  );
}

describe("handlePageRoute — public share routes (/s/...)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPasskeyAuditForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("skips i18n + auth, applies security headers, no fetch fired", async () => {
    const res = await handlePageRoute(makePageRequest("/s/some-token"), dummyOptions);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockIntlMiddleware).not.toHaveBeenCalled();
  });
});

describe("handlePageRoute — protected routes auth check", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPasskeyAuditForTests();
    // Default: a normal user WITH an active tenant membership. A null return
    // (deactivated member) now fails session validation, so it is no longer a
    // valid baseline for a session that should reach access/passkey checks.
    mockResolveUserTenantId.mockResolvedValue("t-1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("redirects /dashboard without session to signin with callbackUrl", async () => {
    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords"),
      dummyOptions,
    );
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/signin");
    expect(location).toContain("callbackUrl=");
  });

  it("redirects a deactivated member (no active tenant membership) to signin", async () => {
    // Valid Auth.js session response, but resolveUserTenantId returns null
    // (deactivatedAt != null) → getSessionInfo fails closed → protected page
    // redirects to signin instead of rendering with the tenant IP gate skipped.
    // A cookie is required so getSessionInfo reaches the fetch + resolve path
    // (a cookieless request short-circuits to {valid:false} before either).
    mockValidSession(fetchSpy, { id: "u-deactivated" });
    mockResolveUserTenantId.mockResolvedValueOnce(null);

    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", {
        cookie: "authjs.session-token=sess-deactivated",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain("/auth/signin");
  });

  it("emits Set-Cookie deletions with full attribute set (Secure on https)", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords"),
      dummyOptions,
    );
    const headers = res.headers.getSetCookie();
    // ALL_KNOWN_SESSION_COOKIE_NAMES has 5 entries — every one must be emitted.
    const names = [
      "__Host-authjs.session-token",
      "__Secure-authjs.session-token",
      "authjs.session-token",
      "__Secure-next-auth.session-token",
      "next-auth.session-token",
    ];
    for (const name of names) {
      const line = headers.find((h) => h.startsWith(`${name}=`));
      expect(line, `Set-Cookie for ${name} not emitted`).toBeDefined();
      // RFC 6265bis §4.1.3.1/§4.1.3.2 require Secure on `__Secure-` / `__Host-`
      // cookies; without it the browser silently rejects the Set-Cookie and the
      // cookie persists — the masking bug this contract fixes.
      expect(line, `${name} missing Secure`).toMatch(/;\s*Secure/i);
      expect(line, `${name} missing HttpOnly`).toMatch(/;\s*HttpOnly/i);
      expect(line, `${name} missing SameSite=lax`).toMatch(/;\s*SameSite=lax/i);
      // Deletion marker — Max-Age=0 or epoch Expires.
      expect(line, `${name} not a deletion`).toMatch(
        /Max-Age=0|Expires=Thu,\s*01\s*Jan\s*1970/i,
      );
    }
  });

  it("does NOT add Secure to deletion when AUTH_URL is http (dev)", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords"),
      dummyOptions,
    );
    const headers = res.headers.getSetCookie();
    // Proves the `useSecureCookies` plumbing is live, not hardcoded.
    // A hardcoded `secure: true` would pass the https test above but break
    // dev logout / redirect-clear here. Use the unprefixed name (the only
    // legal one when useSecureCookies=false; prefixed forms emit but are
    // browser-rejected, which is correct).
    const line = headers.find((h) => h.startsWith("authjs.session-token="));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=lax/i);
  });

  it("allows /dashboard with valid session (returns intl response with security headers)", async () => {
    // Full passkey-field shape (all four present, non-enforcing) — C4's
    // bundle-substitution fires only when a field is genuinely absent from
    // the session response; this test verifies the ordinary non-enforcing
    // pass-through, not fail-closed drift handling.
    mockValidSession(fetchSpy, {
      hasPasskey: false,
      requirePasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", {
        cookie: "authjs.session-token=sess-1",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  it("returns 403 when access is denied (security headers attached)", async () => {
    mockValidSession(fetchSpy);
    mockResolveUserTenantId.mockResolvedValueOnce("t-1");
    mockCheckAccessWithAudit.mockResolvedValueOnce({
      allowed: false,
      reason: "ip blocked",
    });

    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", {
        cookie: "authjs.session-token=sess-blocked",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  it("non-protected page (e.g. /ja/auth/signin) skips auth check", async () => {
    const res = await handlePageRoute(
      makePageRequest("/ja/auth/signin"),
      dummyOptions,
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("handlePageRoute — passkey enforcement", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPasskeyAuditForTests();
    // Default: a normal user WITH an active tenant membership. A null return
    // (deactivated member) now fails session validation, so it is no longer a
    // valid baseline for a session that should reach access/passkey checks.
    mockResolveUserTenantId.mockResolvedValue("t-1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("redirects to settings/auth/passkey when requirePasskey + !hasPasskey + grace expired", async () => {
    mockValidSession(fetchSpy, {
      id: "u-pk-1",
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      passkeyGracePeriodDays: 1,
    });

    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", {
        cookie: "authjs.session-token=sess-pk",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain("/dashboard/settings/auth/passkey");
  });

  it("does NOT redirect when grace period has not expired", async () => {
    mockValidSession(fetchSpy, {
      id: "u-pk-2",
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date().toISOString(),
      passkeyGracePeriodDays: 30,
    });

    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", {
        cookie: "authjs.session-token=sess-pk2",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
  });

  it("does NOT redirect when on the exempt passkey settings page (loop guard)", async () => {
    mockValidSession(fetchSpy, {
      id: "u-pk-3",
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      passkeyGracePeriodDays: 1,
    });

    const res = await handlePageRoute(
      makePageRequest("/ja/dashboard/settings/auth/passkey", {
        cookie: "authjs.session-token=sess-pk3",
      }),
      dummyOptions,
    );
    expect(res.status).toBe(200);
  });
});

describe("recordPasskeyAuditEmit — module-state isolated dedup", () => {
  beforeEach(() => {
    _resetPasskeyAuditForTests();
  });

  const PATH_A = "/dashboard/passwords";

  it("records first emit for a user+path (returns true)", () => {
    expect(recordPasskeyAuditEmit("u-a", PATH_A, 1_000)).toBe(true);
    expect(_passkeyAuditHasForTests("u-a", PATH_A)).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(1);
  });

  it("dedupes a second emit within DEDUP_MS for the same user+path", () => {
    expect(recordPasskeyAuditEmit("u-b", PATH_A, 1_000)).toBe(true);
    expect(recordPasskeyAuditEmit("u-b", PATH_A, 1_000 + PASSKEY_AUDIT_DEDUP_MS)).toBe(false);
  });

  it("permits a fresh emit just past DEDUP_MS boundary (1ms after the inclusive window)", () => {
    expect(recordPasskeyAuditEmit("u-c", PATH_A, 1_000)).toBe(true);
    expect(
      recordPasskeyAuditEmit("u-c", PATH_A, 1_000 + PASSKEY_AUDIT_DEDUP_MS + 1),
    ).toBe(true);
  });

  it("evicts the staleness-oldest entry when map exceeds PASSKEY_AUDIT_MAP_MAX", () => {
    // Fill map to exactly MAX with distinct users (each with their own path key).
    for (let i = 0; i < PASSKEY_AUDIT_MAP_MAX; i += 1) {
      recordPasskeyAuditEmit(`user-${i}`, PATH_A, 1_000 + i);
    }
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditFirstKeyForTests()).toBe(`user-0:${PATH_A}`);

    // One more accepted emit triggers eviction of the staleness head (user-0:PATH_A).
    recordPasskeyAuditEmit("overflow-user", PATH_A, 1_000 + PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditHasForTests("user-0", PATH_A)).toBe(false);
    expect(_passkeyAuditHasForTests("overflow-user", PATH_A)).toBe(true);
  });

  it("re-emit refreshes recency: oldest key shifts to the next-oldest user", () => {
    recordPasskeyAuditEmit("u-old", PATH_A, 1_000);
    recordPasskeyAuditEmit("u-mid", PATH_A, 2_000);
    recordPasskeyAuditEmit("u-new", PATH_A, 3_000);
    expect(_passkeyAuditFirstKeyForTests()).toBe(`u-old:${PATH_A}`);

    // u-old re-emits past DEDUP_MS → moves to the tail.
    recordPasskeyAuditEmit("u-old", PATH_A, 1_000 + PASSKEY_AUDIT_DEDUP_MS + 1);
    expect(_passkeyAuditFirstKeyForTests()).toBe(`u-mid:${PATH_A}`);
  });

  it("same user + different blocked path within window → NOT deduped (two emits)", () => {
    const PATH_B = "/dashboard/settings";
    expect(recordPasskeyAuditEmit("u-d", PATH_A, 1_000)).toBe(true);
    // Same user, different path — NOT deduped.
    expect(recordPasskeyAuditEmit("u-d", PATH_B, 1_000)).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(2);
  });
});

describe("handlePageRoute — passkey audit dedup over consecutive requests", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPasskeyAuditForTests();
    // Default: a normal user WITH an active tenant membership. A null return
    // (deactivated member) now fails session validation, so it is no longer a
    // valid baseline for a session that should reach access/passkey checks.
    mockResolveUserTenantId.mockResolvedValue("t-1");
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: true });
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("first redirect fires internal audit-emit fetch; second redirect within window does not", async () => {
    mockValidSession(fetchSpy, {
      id: "u-dedup",
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      passkeyGracePeriodDays: 1,
    });

    const baseHeaders = { cookie: "authjs.session-token=sess-dedup" };

    await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", baseHeaders),
      dummyOptions,
    );
    // Wait microtask so void-fetch enqueues.
    await new Promise((r) => setImmediate(r));

    const sessionFetches = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/auth/session"),
    ).length;
    const auditFetches = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/internal/audit-emit"),
    ).length;
    expect(sessionFetches).toBeGreaterThanOrEqual(1);
    expect(auditFetches).toBe(1);

    // Second request — same user, within dedup window — must NOT enqueue
    // another internal audit-emit fetch.
    await handlePageRoute(
      makePageRequest("/ja/dashboard/passwords", baseHeaders),
      dummyOptions,
    );
    await new Promise((r) => setImmediate(r));
    const auditFetchesAfter = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/internal/audit-emit"),
    ).length;
    expect(auditFetchesAfter).toBe(1);
    expect(_passkeyAuditSizeForTests()).toBe(1);
  });

  // F18: same user + SAME blocked path within the window → one emit;
  // same user + DIFFERENT blocked page path within the window → TWO emits.
  it("F18: same user + same path deduped; same user + different path emits a second audit", async () => {
    const sessionUser = {
      id: "u-f18",
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      passkeyGracePeriodDays: 1,
    };
    mockValidSession(fetchSpy, sessionUser);

    const headers = { cookie: "authjs.session-token=sess-f18" };

    // First request to /ja/dashboard/passwords → audit emit fires.
    await handlePageRoute(makePageRequest("/ja/dashboard/passwords", headers), dummyOptions);
    await new Promise((r) => setImmediate(r));
    const auditAfterFirst = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/internal/audit-emit"),
    ).length;
    expect(auditAfterFirst).toBe(1);

    // Second request to the SAME path → deduped, no second emit.
    mockValidSession(fetchSpy, sessionUser);
    await handlePageRoute(makePageRequest("/ja/dashboard/passwords", headers), dummyOptions);
    await new Promise((r) => setImmediate(r));
    const auditAfterSamePath = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/internal/audit-emit"),
    ).length;
    expect(auditAfterSamePath).toBe(1);

    // Third request to a DIFFERENT path → NOT deduped, second emit fires.
    mockValidSession(fetchSpy, sessionUser);
    await handlePageRoute(makePageRequest("/ja/dashboard/settings", headers), dummyOptions);
    await new Promise((r) => setImmediate(r));
    const auditAfterDiffPath = fetchSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("/api/internal/audit-emit"),
    ).length;
    expect(auditAfterDiffPath).toBe(2);
  });
});
