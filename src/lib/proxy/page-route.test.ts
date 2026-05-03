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

import {
  handlePageRoute,
  recordPasskeyAuditEmit,
  PASSKEY_AUDIT_DEDUP_MS,
  PASSKEY_AUDIT_MAP_MAX,
  _resetPasskeyAuditForTests,
  _passkeyAuditSizeForTests,
  _passkeyAuditHasForTests,
  _passkeyAuditFirstKeyForTests,
} from "./page-route";

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
    mockResolveUserTenantId.mockResolvedValue(null);
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

  it("allows /dashboard with valid session (returns intl response with security headers)", async () => {
    mockValidSession(fetchSpy);
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
    mockResolveUserTenantId.mockResolvedValue(null);
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

  it("records first emit for a user (returns true)", () => {
    expect(recordPasskeyAuditEmit("u-a", 1_000)).toBe(true);
    expect(_passkeyAuditHasForTests("u-a")).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(1);
  });

  it("dedupes a second emit within DEDUP_MS for the same user", () => {
    expect(recordPasskeyAuditEmit("u-b", 1_000)).toBe(true);
    expect(recordPasskeyAuditEmit("u-b", 1_000 + PASSKEY_AUDIT_DEDUP_MS)).toBe(false);
  });

  it("permits a fresh emit just past DEDUP_MS boundary (1ms after the inclusive window)", () => {
    expect(recordPasskeyAuditEmit("u-c", 1_000)).toBe(true);
    expect(
      recordPasskeyAuditEmit("u-c", 1_000 + PASSKEY_AUDIT_DEDUP_MS + 1),
    ).toBe(true);
  });

  it("evicts the staleness-oldest entry when map exceeds PASSKEY_AUDIT_MAP_MAX", () => {
    // Fill map to exactly MAX with distinct users.
    for (let i = 0; i < PASSKEY_AUDIT_MAP_MAX; i += 1) {
      recordPasskeyAuditEmit(`user-${i}`, 1_000 + i);
    }
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditFirstKeyForTests()).toBe("user-0");

    // One more accepted emit triggers eviction of the staleness head (user-0).
    recordPasskeyAuditEmit("overflow-user", 1_000 + PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditHasForTests("user-0")).toBe(false);
    expect(_passkeyAuditHasForTests("overflow-user")).toBe(true);
  });

  it("re-emit refreshes recency: oldest key shifts to the next-oldest user", () => {
    recordPasskeyAuditEmit("u-old", 1_000);
    recordPasskeyAuditEmit("u-mid", 2_000);
    recordPasskeyAuditEmit("u-new", 3_000);
    expect(_passkeyAuditFirstKeyForTests()).toBe("u-old");

    // u-old re-emits past DEDUP_MS → moves to the tail.
    recordPasskeyAuditEmit("u-old", 1_000 + PASSKEY_AUDIT_DEDUP_MS + 1);
    expect(_passkeyAuditFirstKeyForTests()).toBe("u-mid");
  });
});

describe("handlePageRoute — passkey audit dedup over consecutive requests", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPasskeyAuditForTests();
    mockResolveUserTenantId.mockResolvedValue(null);
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
});
