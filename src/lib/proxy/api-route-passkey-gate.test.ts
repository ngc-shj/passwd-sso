/**
 * The proxy session passkey gate (plan C1), through the real handleApiAuth,
 * the real getSessionInfo and the real session cache over an in-memory Redis.
 * Mocked: the tenant lookup, the IP restriction, the audit write and the
 * limiter factory (to observe its key) — nothing on the session path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { MS_PER_DAY } from "@/lib/constants/time";

const {
  mockCheckAccessWithAudit,
  mockResolveUserTenantId,
  mockLogAuditAsync,
  limiterKeys,
  redisStore,
  redisSetCalls,
} = vi.hoisted(() => ({
  mockCheckAccessWithAudit: vi.fn(),
  mockResolveUserTenantId: vi.fn(),
  mockLogAuditAsync: vi.fn(),
  limiterKeys: [] as string[],
  redisStore: new Map<string, string>(),
  redisSetCalls: [] as { key: string; value: string; ttlMs: number }[],
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: string, _px: string, ttlMs: number, nx?: string) => {
      redisSetCalls.push({ key, value, ttlMs });
      if (nx === "NX" && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
  }),
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  checkAccessRestrictionWithAudit: mockCheckAccessWithAudit,
}));
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));
vi.mock("@/lib/audit/audit", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  logAuditAsync: mockLogAuditAsync,
}));
// A max-1 counter per key, recording each key it is asked about.
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => {
    const counts = new Map<string, number>();
    return {
      check: async (key: string) => {
        limiterKeys.push(key);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { allowed: count <= 1 };
      },
      clear: async () => {},
    };
  },
}));

import { handleApiAuth } from "./api-route";
import {
  _resetSessionPasskeyAuditForTests,
  SESSION_GATE_OWN_GATE,
  SESSION_GATE_TIER_A,
  SESSION_GATE_TIER_B,
} from "./session-passkey-gate";
import {
  hashSessionToken,
  NEGATIVE_CACHE_TTL_MS,
  SESSION_CACHE_KEY_PREFIX,
  _resetSubkeyCacheForTests,
} from "@/lib/auth/session/session-cache";
import {
  dispatchFetch,
  fetchCallsTo,
  PASSKEY_ALLOWED,
  PASSKEY_BLOCKED,
  sessionResponseBody,
  sessionRoute,
  type PasskeyFields,
} from "@/__tests__/helpers/proxy-session-fixtures";

const APP_ORIGIN = "http://localhost:3000";
const SESSION_PATH = "/api/auth/session";
const READER = { method: "POST", path: "/api/auth/passkey/reauth/options" };
const NON_READER = { method: "POST", path: "/api/maintenance/purge-history" };

let fetchSpy: ReturnType<typeof vi.spyOn>;
let tokenSeq = 0;

/** A fresh, well-formed session token per request, so no cell reads another's cache entry. */
function nextToken(): string {
  tokenSeq += 1;
  return `5e55aaaa-0000-4000-8000-${tokenSeq.toString(16).padStart(12, "0")}`;
}

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, {
    method,
    headers: { origin: APP_ORIGIN, ...headers },
  });
}

function withCookie(method: string, path: string, token = nextToken(), extra: Record<string, string> = {}) {
  return request(method, path, { cookie: `authjs.session-token=${token}`, ...extra });
}

function answerSession(body: unknown) {
  fetchSpy.mockImplementation(dispatchFetch(sessionRoute(body)));
}

function answerUser(passkey: PasskeyFields, extra: Record<string, unknown> = {}) {
  answerSession(sessionResponseBody("u-1", passkey, extra));
}

/** An entry's path with `<id>` filled in, the way a client sends it. */
function concrete(path: string): string {
  return path.replace("<id>", "google");
}

beforeEach(() => {
  vi.stubEnv("AUTH_URL", "");
  vi.stubEnv("NEXTAUTH_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("SESSION_TOKEN_HMAC_KEY", "ab".repeat(32));
  _resetSubkeyCacheForTests();
  _resetSessionPasskeyAuditForTests();
  redisStore.clear();
  redisSetCalls.length = 0;
  limiterKeys.length = 0;
  mockLogAuditAsync.mockReset().mockResolvedValue(undefined);
  mockCheckAccessWithAudit.mockReset().mockResolvedValue({ allowed: true });
  mockResolveUserTenantId.mockReset().mockResolvedValue("t-1");
  fetchSpy = vi.spyOn(globalThis, "fetch");
  answerUser(PASSKEY_BLOCKED);
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect((await res.json()).error).toBe(error);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
}

describe("session passkey gate — deny and allow", () => {
  it("refuses a blocked session with PASSKEY_REQUIRED after reading the session", async () => {
    const res = await handleApiAuth(withCookie("GET", "/api/passwords"));
    await expectRefused(res, 403, "PASSKEY_REQUIRED");
    expect(fetchCallsTo(fetchSpy, SESSION_PATH)).toHaveLength(1);
  });

  it("passes a session whose tenant does not require a passkey", async () => {
    answerUser(PASSKEY_ALLOWED);
    const res = await handleApiAuth(withCookie("GET", "/api/passwords"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("passes a member who has a passkey under a requiring tenant", async () => {
    answerUser({ ...PASSKEY_BLOCKED, hasPasskey: true });
    expect((await handleApiAuth(withCookie("GET", "/api/passwords"))).status).toBe(200);
  });

  it("gates API_DEFAULT routes too when a cookie is present", async () => {
    const res = await handleApiAuth(withCookie("POST", "/api/maintenance/purge-history"));
    await expectRefused(res, 403, "PASSKEY_REQUIRED");
  });

  it("passes an API_DEFAULT route with no session cookie, without reading a session", async () => {
    const res = await handleApiAuth(request("POST", "/api/maintenance/purge-history"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gates a cookie sent beside a junk Bearer on a Bearer-eligible route", async () => {
    const res = await handleApiAuth(
      withCookie("GET", "/api/passwords", undefined, { authorization: "Bearer junk" }),
    );
    await expectRefused(res, 403, "PASSKEY_REQUIRED");
  });

  it("leaves a Bearer-only request to the route, with no session read", async () => {
    const res = await handleApiAuth(request("GET", "/api/passwords", { authorization: "Bearer tok" }));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers OPTIONS with a blocked cookie with 204 and no session read", async () => {
    const res = await handleApiAuth(withCookie("OPTIONS", "/api/passwords"));
    expect(res.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("session passkey gate — grace boundary", () => {
  const ENABLED_AT = new Date("2026-03-01T00:00:00.000Z");
  const GRACE_DAYS = 7;
  const GRACE_END_MS = ENABLED_AT.getTime() + GRACE_DAYS * MS_PER_DAY;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    answerUser({
      hasPasskey: false,
      requirePasskey: true,
      requirePasskeyEnabledAt: ENABLED_AT.toISOString(),
      passkeyGracePeriodDays: GRACE_DAYS,
    });
  });

  it("passes at the last millisecond of the grace period", async () => {
    vi.setSystemTime(GRACE_END_MS);
    expect((await handleApiAuth(withCookie("GET", "/api/passwords"))).status).toBe(200);
  });

  it("refuses one millisecond after the grace period ends", async () => {
    vi.setSystemTime(GRACE_END_MS + 1);
    await expectRefused(await handleApiAuth(withCookie("GET", "/api/passwords")), 403, "PASSKEY_REQUIRED");
  });
});

describe("session passkey gate — Tier A", () => {
  it.each(SESSION_GATE_TIER_A.map((e) => [e.method, concrete(e.path)]))(
    "%s %s passes a blocked cookie without reading the session",
    async (method, path) => {
      const res = await handleApiAuth(withCookie(method, path));
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockLogAuditAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", "/api/auth/signin/google", "signin/<id> is POST-only"],
    ["POST", "/api/auth/callback/google/extra", "a provider ID is one segment"],
    ["GET", "/api/auth/callback", "callback needs a provider ID"],
    ["GET", "/api/auth/session/extra", "session takes no provider ID"],
    ["DELETE", "/api/auth/session", "method not listed"],
    ["POST", "/api/auth/passkey/reauth/options", "passkey reauth is not exempt"],
    ["GET", "/api/auth/passkey/options", "pre-auth passkey routes are POST-only"],
  ])("%s %s is gated (%s)", async (method, path) => {
    await expectRefused(await handleApiAuth(withCookie(method, path)), 403, "PASSKEY_REQUIRED");
    expect(fetchCallsTo(fetchSpy, SESSION_PATH)).toHaveLength(1);
  });
});

describe("session passkey gate — Tier B", () => {
  const tierB = SESSION_GATE_TIER_B.map((e) => [e.method, e.path]);

  it.each(tierB)("%s %s passes a blocked session after reading it", async (method, path) => {
    const res = await handleApiAuth(withCookie(method, path));
    expect(res.status).toBe(200);
    expect(fetchCallsTo(fetchSpy, SESSION_PATH)).toHaveLength(1);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it.each(tierB)("%s %s keeps the 401 for an invalid session", async (method, path) => {
    answerSession(null);
    await expectRefused(await handleApiAuth(withCookie(method, path)), 401, "UNAUTHORIZED");
  });

  it.each(tierB)("%s %s keeps ACCESS_DENIED for a denied IP", async (method, path) => {
    mockCheckAccessWithAudit.mockResolvedValue({ allowed: false });
    await expectRefused(await handleApiAuth(withCookie(method, path)), 403, "ACCESS_DENIED");
  });

  it.each([
    ["DELETE", "/api/webauthn/credentials/cred-1"],
    ["POST", "/api/vault/delegation"],
    ["GET", "/api/vault/status"],
  ])("%s %s (not exempt) is refused", async (method, path) => {
    await expectRefused(await handleApiAuth(withCookie(method, path)), 403, "PASSKEY_REQUIRED");
  });
});

describe("session passkey gate — own-gate routes", () => {
  it.each(SESSION_GATE_OWN_GATE.map((e) => [e.method, e.path]))(
    "%s %s passes a blocked session through to the route",
    async (method, path) => {
      const res = await handleApiAuth(withCookie(method, path));
      expect(res.status).toBe(200);
      expect(fetchCallsTo(fetchSpy, SESSION_PATH)).toHaveLength(1);
      expect(mockLogAuditAsync).not.toHaveBeenCalled();
    },
  );

  it("mobile/authorize (API_DEFAULT) passes an ambiguous cookie to the route", async () => {
    const res = await handleApiAuth(
      request("GET", "/api/mobile/authorize", { cookie: "authjs.session-token.0=5e55" }),
    );
    expect(res.status).toBe(200);
  });

  it("mcp/authorize (API_SESSION_REQUIRED) answers an ambiguous cookie with 401", async () => {
    const res = await handleApiAuth(
      request("GET", "/api/mcp/authorize", { cookie: "authjs.session-token.0=5e55" }),
    );
    await expectRefused(res, 401, "UNAUTHORIZED");
  });
});

describe("session passkey gate — invalid sessions on API_DEFAULT", () => {
  // Each way getSessionInfo answers valid:false. `cookie` builds the request
  // cookie; `arrange` sets up the source.
  const sources: [string, (token: string) => string, () => void][] = [
    ["an ambiguous cookie", (t) => `authjs.session-token.0=${t}`, () => {}],
    // Auth.js answers a dead token and a swallowed adapter error with the
    // same 200-null, so one cell covers both.
    [
      "a 200-null (a dead token, or an adapter fault Auth.js swallows)",
      (t) => `authjs.session-token=${t}`,
      () => answerSession(null),
    ],
    [
      "a non-ok session fetch",
      (t) => `authjs.session-token=${t}`,
      () => fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 })),
    ],
    [
      "a deactivated member",
      (t) => `authjs.session-token=${t}`,
      () => mockResolveUserTenantId.mockResolvedValue(null),
    ],
    [
      "a tenant lookup that throws",
      (t) => `authjs.session-token=${t}`,
      () => mockResolveUserTenantId.mockRejectedValue(new Error("db down")),
    ],
  ];

  it.each(sources)("a session reader answers 401 for %s", async (_label, cookie, arrange) => {
    arrange();
    const res = await handleApiAuth(request(READER.method, READER.path, { cookie: cookie(nextToken()) }));
    await expectRefused(res, 401, "UNAUTHORIZED");
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it.each(sources)("control: a non-reader passes the same %s through", async (_label, cookie, arrange) => {
    arrange();
    const res = await handleApiAuth(
      request(NON_READER.method, NON_READER.path, { cookie: cookie(nextToken()) }),
    );
    expect(res.status).toBe(200);
  });

  it("a session reader answers 401 for a negative-cache hit, without a session fetch", async () => {
    const token = nextToken();
    redisStore.set(`${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`, JSON.stringify({ valid: false }));
    const res = await handleApiAuth(withCookie(READER.method, READER.path, token));
    await expectRefused(res, 401, "UNAUTHORIZED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("control: a non-reader passes a negative-cache hit through", async () => {
    const token = nextToken();
    redisStore.set(`${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`, JSON.stringify({ valid: false }));
    expect((await handleApiAuth(withCookie(NON_READER.method, NON_READER.path, token))).status).toBe(200);
  });

  it("a session reader refuses a valid blocked session with PASSKEY_REQUIRED", async () => {
    await expectRefused(
      await handleApiAuth(withCookie(READER.method, READER.path)),
      403,
      "PASSKEY_REQUIRED",
    );
  });
});

describe("session passkey gate — degraded passkey state", () => {
  const CATCH_BUNDLE: PasskeyFields = {
    hasPasskey: false,
    requirePasskey: true,
    requirePasskeyEnabledAt: null,
    passkeyGracePeriodDays: null,
  };

  function cacheWritesFor(token: string) {
    const key = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
    return redisSetCalls.filter((call) => call.key === key);
  }

  it("answers a marked bundle with 503, writes no audit row, and caches it for the negative TTL", async () => {
    answerUser(CATCH_BUNDLE, { passkeyStateDegraded: true });
    const token = nextToken();

    await expectRefused(
      await handleApiAuth(withCookie("GET", "/api/passwords", token)),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
    const writes = cacheWritesFor(token);
    expect(writes).toHaveLength(1);
    expect(writes[0].ttlMs).toBe(NEGATIVE_CACHE_TTL_MS);
  });

  it("keeps the mark through the cache: a hit parsed by SessionInfoSchema is still a 503", async () => {
    answerUser(CATCH_BUNDLE, { passkeyStateDegraded: true });
    const token = nextToken();
    await handleApiAuth(withCookie("GET", "/api/passwords", token));

    const res = await handleApiAuth(withCookie("GET", "/api/passwords", token));
    await expectRefused(res, 503, "SERVICE_UNAVAILABLE");
    // The second answer came from the cache entry, not a second session read.
    expect(fetchCallsTo(fetchSpy, SESSION_PATH)).toHaveLength(1);
    expect(mockLogAuditAsync).not.toHaveBeenCalled();
  });

  it("marks and short-caches a bundle it substituted for a missing passkey field", async () => {
    answerSession({ user: { id: "u-1" }, expires: new Date(Date.now() + MS_PER_DAY).toISOString() });
    const token = nextToken();

    await expectRefused(
      await handleApiAuth(withCookie("GET", "/api/passwords", token)),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(cacheWritesFor(token)[0].ttlMs).toBe(NEGATIVE_CACHE_TTL_MS);
  });

  it("control: an unmarked blocked bundle is cached for its session lifetime", async () => {
    const token = nextToken();
    await handleApiAuth(withCookie("GET", "/api/passwords", token));
    expect(cacheWritesFor(token)[0].ttlMs).toBeGreaterThan(NEGATIVE_CACHE_TTL_MS);
  });

  it("still leaves a Tier B route to decide on the raw fields", async () => {
    answerUser(CATCH_BUNDLE, { passkeyStateDegraded: true });
    expect((await handleApiAuth(withCookie("POST", "/api/webauthn/register/options"))).status).toBe(200);
  });
});

describe("session passkey gate — audit", () => {
  it("writes one row per user and blockedPath, bounded through the shared limiter key", async () => {
    const token = nextToken();
    await handleApiAuth(withCookie("GET", "/api/passwords", token));
    await handleApiAuth(withCookie("GET", "/api/passwords/entry-123", token));

    expect(limiterKeys).toEqual([
      "rl:passkey_session_gate_audit:u-1:GET /api/passwords",
      "rl:passkey_session_gate_audit:u-1:GET /api/passwords",
    ]);
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(1);
    expect(mockLogAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "PASSKEY_ENFORCEMENT_BLOCKED",
        userId: "u-1",
        tenantId: "t-1",
        metadata: { blockedPath: "GET /api/passwords" },
      }),
    );
  });

  it("writes a separate row for another blockedPath", async () => {
    const token = nextToken();
    await handleApiAuth(withCookie("GET", "/api/passwords", token));
    await handleApiAuth(withCookie("GET", "/api/tags", token));
    expect(mockLogAuditAsync).toHaveBeenCalledTimes(2);
  });

  it("collapses an unknown first segment to `other` and an unlisted method to OTHER", async () => {
    const token = nextToken();
    await handleApiAuth(withCookie("GET", "/api/no-such-dir/xyz", token));
    await handleApiAuth(withCookie("HEAD", "/api/passwords", token));
    expect(mockLogAuditAsync.mock.calls.map(([params]) => params.metadata)).toEqual([
      { blockedPath: "GET /api/other" },
      { blockedPath: "OTHER /api/passwords" },
    ]);
  });
});
