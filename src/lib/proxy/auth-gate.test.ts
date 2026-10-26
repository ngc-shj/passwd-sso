import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLogger } from "@/lib/logger";

// The fail-closed substitution below emits the ONLY signal that it happened.
// Mocked so the assertion can pin both the message and the `missing` list.
vi.mock("@/lib/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, default: logger };
});
import { NextRequest } from "next/server";

const { mockGetCachedSession, mockSetCachedSession, mockResolveUserTenantId } =
  vi.hoisted(() => ({
    mockGetCachedSession: vi.fn(),
    mockSetCachedSession: vi.fn(),
    mockResolveUserTenantId: vi.fn(),
  }));

vi.mock("@/lib/auth/session/session-cache", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/session/session-cache")
  >("@/lib/auth/session/session-cache");
  return {
    ...actual,
    getCachedSession: mockGetCachedSession,
    setCachedSession: mockSetCachedSession,
  };
});
vi.mock("@/lib/tenant-context", () => ({
  resolveUserTenantId: mockResolveUserTenantId,
}));

import { hasSessionCookie, getSessionInfo } from "./auth-gate";
import { TEST_SESSION_TOKEN } from "@/__tests__/helpers/fixtures";
import { cachedSessionInfo, PASSKEY_BLOCKED } from "@/__tests__/helpers/proxy-session-fixtures";
import { NEGATIVE_CACHE_TTL_MS } from "@/lib/auth/session/session-cache";

const APP_ORIGIN = "http://localhost:3000";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/passwords`, { headers });
}

/**
 * The deployment shapes whose configured name is not the first entry of
 * ALL_KNOWN_SESSION_COOKIE_NAMES: https with a basePath (`__Secure-`), and
 * http (`authjs.session-token`). `__Host-` comes first in that list, so these
 * are the shapes where reading "any known name" disagreed with Auth.js.
 */
const SECURE_BASEPATH = { AUTH_URL: "https://app.example.test/passwd-sso", NEXT_PUBLIC_BASE_PATH: "/passwd-sso" };
const PLAIN_HTTP = { AUTH_URL: "http://localhost:3000", NEXT_PUBLIC_BASE_PATH: "" };

function stubDeployment(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const SESSION_A = "0b6f1c2e-8d4a-4f7e-9a1b-3c5d7e9f0a2b";
const SESSION_B = "5a7c9e1f-2b4d-4c6e-8f0a-1b3d5f7a9c0e";

describe("hasSessionCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when cookie header includes a recognised cookie", () => {
    expect(hasSessionCookie(`authjs.session-token=${SESSION_A}`)).toBe(true);
  });

  it("returns false when no recognised cookie is present", () => {
    expect(hasSessionCookie("foo=bar")).toBe(false);
  });

  it("returns false for empty cookie header", () => {
    expect(hasSessionCookie("")).toBe(false);
  });

  it("still sees any known name, not only the configured one (CSRF stays broad)", () => {
    stubDeployment(SECURE_BASEPATH);
    expect(hasSessionCookie("__Host-authjs.session-token=X")).toBe(true);
  });

  it("sees a chunk-named cookie, which auth() would collect", () => {
    stubDeployment(PLAIN_HTTP);
    expect(hasSessionCookie(`authjs.session-token.0=${SESSION_B}`)).toBe(true);
  });
});

describe("getSessionInfo binds the cache to the session Auth.js resolves", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGetCachedSession.mockReset();
    mockSetCachedSession.mockReset();
    mockResolveUserTenantId.mockReset();
    vi.mocked(getLogger().warn).mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("looks up and forwards the configured cookie, not an attacker-chosen __Host- key sent first", async () => {
    stubDeployment(SECURE_BASEPATH);
    // Step 2 of the attack: a key the attacker bound to another session's
    // info earlier, sent ahead of the session being authenticated. The cache
    // must be asked about session B, and the session read must see only B.
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await getSessionInfo(
      makeRequest({
        cookie: `__Host-authjs.session-token=attacker-key; __Secure-authjs.session-token=${SESSION_B}; other=1`,
      }),
    );

    expect(mockGetCachedSession).toHaveBeenCalledWith(SESSION_B);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe(`__Secure-authjs.session-token=${SESSION_B}`);
  });

  it("reads a whitespace-spelled key as Auth.js does and forwards it canonically", async () => {
    stubDeployment(PLAIN_HTTP);
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await getSessionInfo(makeRequest({ cookie: `other=1; authjs.session-token\t= ${SESSION_A}` }));

    expect(mockGetCachedSession).toHaveBeenCalledWith(SESSION_A);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe(`authjs.session-token=${SESSION_A}`);
  });

  it("is invalid, with no cache lookup and no fetch, when only a non-configured cookie is sent", async () => {
    stubDeployment(SECURE_BASEPATH);
    // A well-formed token, so only the name keeps it from the cache lookup.
    const result = await getSessionInfo(makeRequest({ cookie: `__Host-authjs.session-token=${SESSION_A}` }));
    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Not configured is "no session", not a refused reading.
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  // `name =B; name=A`: the old exact-key compare skipped the first pair and
  // decided on A, while Auth.js trims the key and resolves B. Duplicates now
  // resolve as Auth.js resolves them, the first, and only that is forwarded.
  it.each([
    ["a whitespace-spelled duplicate", `authjs.session-token =${SESSION_B}; authjs.session-token=${SESSION_A}`, SESSION_B],
    ["an exact duplicate", `authjs.session-token=${SESSION_A}; authjs.session-token=${SESSION_B}`, SESSION_A],
  ])("decides on the first occurrence for %s and forwards it alone", async (_label, cookie, first) => {
    stubDeployment(PLAIN_HTTP);
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await getSessionInfo(makeRequest({ cookie }));

    expect(mockGetCachedSession).toHaveBeenCalledWith(first);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe(`authjs.session-token=${first}`);
  });

  it.each([
    ["a chunk-named cookie", `authjs.session-token.0=${SESSION_B}`],
    ["a %-encoded value", "authjs.session-token=%30b6f"],
    ["a quoted value", `authjs.session-token="${SESSION_A}"`],
  ])("is invalid, logged, with no cache lookup and no fetch, for %s", async (_label, cookie) => {
    stubDeployment(PLAIN_HTTP);
    const result = await getSessionInfo(makeRequest({ cookie }));
    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getLogger().warn).toHaveBeenCalledWith({
      msg: "auth-gate: ambiguous session cookie refused",
    });
  });
});

describe("getSessionInfo", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stubDeployment(PLAIN_HTTP);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGetCachedSession.mockReset();
    mockSetCachedSession.mockReset();
    mockResolveUserTenantId.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("returns invalid (no fetch) when cookie header is missing", async () => {
    const result = await getSessionInfo(makeRequest());
    expect(result).toEqual({ valid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockGetCachedSession).not.toHaveBeenCalled();
  });

  it("returns invalid (no fetch) when cookie has no session token", async () => {
    const result = await getSessionInfo(makeRequest({ cookie: "foo=bar" }));
    expect(result).toEqual({ valid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns cached SessionInfo without firing fetch (cache-hit)", async () => {
    const cached = cachedSessionInfo("u-1", "t-1", PASSKEY_BLOCKED);
    mockGetCachedSession.mockResolvedValueOnce(cached);

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("on cache-miss + valid response: fetch fires, setCachedSession is called", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u-2",
            hasPasskey: true,
            requirePasskey: false,
            requirePasskeyEnabledAt: null,
            passkeyGracePeriodDays: null,
          },
          expires: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    mockResolveUserTenantId.mockResolvedValueOnce("t-2");

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result.valid).toBe(true);
    expect(result.userId).toBe("u-2");
    expect(result.tenantId).toBe("t-2");
    expect(result.hasPasskey).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSetCachedSession).toHaveBeenCalledTimes(1);
  });

  // C4: full-shape response (all four passkey fields present) must pass
  // through unchanged — regression pin using non-default values so
  // pass-through is observable (requirePasskey:true + hasPasskey:true would
  // be silently masked by the fail-closed bundle's own values otherwise).
  it("full-shape passkey fields pass through unchanged (regression pin)", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u-full",
            hasPasskey: true,
            requirePasskey: true,
            requirePasskeyEnabledAt: "2026-01-01T00:00:00.000Z",
            passkeyGracePeriodDays: 14,
          },
          expires: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    mockResolveUserTenantId.mockResolvedValueOnce("t-full");

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result.valid).toBe(true);
    expect(result.hasPasskey).toBe(true);
    expect(result.requirePasskey).toBe(true);
    expect(result.requirePasskeyEnabledAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.passkeyGracePeriodDays).toBe(14);
    expect(mockSetCachedSession).toHaveBeenCalledTimes(1);
  });

  // C4: bundle-level fail-closed substitution — if ANY of the four passkey
  // fields is absent from a valid session response, the ENTIRE fail-closed
  // bundle is substituted (not just the missing field), mirroring src/auth.ts's
  // own catch-path bundle. Mutation check: deleting the substitution branch
  // makes these four tests fail (hasPasskey/requirePasskeyEnabledAt/
  // passkeyGracePeriodDays would retain their per-field `?? false`/`?? null`
  // defaults instead of the full bundle, or requirePasskey would stay false).
  describe("C4: bundle-level fail-closed substitution on missing passkey field", () => {
    const fullUser = {
      id: "u-drift",
      hasPasskey: true,
      requirePasskey: true,
      requirePasskeyEnabledAt: "2026-01-01T00:00:00.000Z",
      passkeyGracePeriodDays: 14,
    };

    it.each([
      "hasPasskey",
      "requirePasskey",
      "requirePasskeyEnabledAt",
      "passkeyGracePeriodDays",
    ] as const)("substitutes the fail-closed bundle when %s is missing", async (omittedField) => {
      mockGetCachedSession.mockResolvedValueOnce(null);
      const user = { ...fullUser };
      delete (user as Record<string, unknown>)[omittedField];
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user,
            expires: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200 },
        ),
      );
      mockResolveUserTenantId.mockResolvedValueOnce("t-drift");

      const result = await getSessionInfo(
        makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
      );

      expect(result.valid).toBe(true);
      expect(result.requirePasskey).toBe(true);
      expect(result.hasPasskey).toBe(false);
      expect(result.requirePasskeyEnabledAt).toBeNull();
      expect(result.passkeyGracePeriodDays).toBeNull();
      // The substituted bundle is an outage, and is cached only briefly.
      expect(result.passkeyStateDegraded).toBe(true);
      expect(mockSetCachedSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
        expect.objectContaining({ passkeyStateDegraded: true }),
        NEGATIVE_CACHE_TTL_MS,
      );

      // The substitution must stay observable. Without this the bundle could be
      // swapped in silently and the whole suite would still pass — a
      // security-relevant degradation with no signal.
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: expect.stringContaining("substituting fail-closed bundle"),
          missing: expect.arrayContaining([omittedField]),
        }),
      );
    });
  });

  // D7: the session callback marks its own catch bundle. The mark must reach
  // SessionInfo, and the entry must be cached for the negative TTL, not the
  // session's lifetime, so a transient fault is re-read within seconds.
  describe("degraded passkey state", () => {
    const catchBundleUser = {
      id: "u-degraded",
      hasPasskey: false,
      requirePasskey: true,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    };

    function respond(user: Record<string, unknown>) {
      mockGetCachedSession.mockResolvedValueOnce(null);
      mockResolveUserTenantId.mockResolvedValueOnce("t-1");
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ user, expires: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200 },
        ),
      );
    }

    it("carries passkeyStateDegraded from the response and caches it for the negative TTL", async () => {
      respond({ ...catchBundleUser, passkeyStateDegraded: true });

      const result = await getSessionInfo(
        makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
      );

      expect(result.passkeyStateDegraded).toBe(true);
      expect(mockSetCachedSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
        expect.objectContaining({ passkeyStateDegraded: true }),
        NEGATIVE_CACHE_TTL_MS,
      );
    });

    it("control: an unmarked response is not degraded and keeps the session-lifetime TTL", async () => {
      respond({ ...catchBundleUser, passkeyStateDegraded: false });

      const result = await getSessionInfo(
        makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
      );

      expect(result.passkeyStateDegraded).toBe(false);
      const ttlMs = mockSetCachedSession.mock.calls[0][2] as number;
      expect(ttlMs).toBeGreaterThan(NEGATIVE_CACHE_TTL_MS);
    });

    it("reads only a literal true as degraded", async () => {
      respond({ ...catchBundleUser, passkeyStateDegraded: "true" });

      const result = await getSessionInfo(
        makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
      );

      expect(result.passkeyStateDegraded).toBe(false);
    });
  });

  it("fail-closed: fetch throws → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("fail-closed: fetch returns non-OK (500) → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("fail-closed: malformed JSON body → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("returns valid:false (no user) without resolving tenant when response.user is null", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result.valid).toBe(false);
    expect(result.tenantId).toBeUndefined();
    // Reached the Auth.js read: the verdict is the null user, not a refused cookie.
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockResolveUserTenantId).not.toHaveBeenCalled();
  });

  // Regression (null-tenant fail-open class): a THROW from resolveUserTenantId
  // (DB/RLS error, MULTI_TENANT anomaly) must FAIL CLOSED. Previously the throw
  // was swallowed, leaving tenantId undefined — which makes the downstream proxy
  // IP-restriction gate skip entirely, silently bypassing a restricted tenant's
  // CIDR/Tailscale controls on a transient error. Now the session is treated as
  // invalid (forcing re-auth) and NOT cached.
  // Mutation check: restore the old `catch {}` swallow and this test flips from
  // { valid: false } back to { valid: true, tenantId: undefined } — it fails.
  it("fail-closed: resolveUserTenantId throws → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { id: "u-err" },
          expires: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    mockResolveUserTenantId.mockRejectedValueOnce(new Error("DB down"));

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockResolveUserTenantId).toHaveBeenCalledWith("u-err");
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  // A null resolveUserTenantId return means NO active TenantMember row
  // (deactivatedAt != null — a de-provisioned member). Since User.tenantId is a
  // non-null FK, this is a REVOKED membership, not a legitimate no-tenant user.
  // Fail closed so a stale cookie (or a session whose deletion was missed on
  // deactivation) cannot pass validation AND skip the tenant IP restriction
  // (undefined tenantId bypasses the downstream gate). Session-path analogue of
  // the extension-token C13 deactivated-member rejection.
  // Mutation check: revert to `tenantId = resolved ?? undefined` (keep the
  // session valid) and this test flips from valid:false to valid:true — it fails.
  it("fail-closed: null resolveUserTenantId (deactivated member) → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { id: "u-nomember" },
          expires: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    mockResolveUserTenantId.mockResolvedValueOnce(null);

    const result = await getSessionInfo(
      makeRequest({ cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockGetCachedSession).toHaveBeenCalledWith(TEST_SESSION_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockResolveUserTenantId).toHaveBeenCalledWith("u-nomember");
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });
});
