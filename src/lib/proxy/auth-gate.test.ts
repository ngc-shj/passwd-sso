import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import {
  extractSessionToken,
  hasSessionCookie,
  getSessionInfo,
} from "./auth-gate";

const APP_ORIGIN = "http://localhost:3000";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/passwords`, { headers });
}

describe("extractSessionToken", () => {
  it("extracts authjs.session-token value", () => {
    expect(extractSessionToken("authjs.session-token=tok-1")).toBe("tok-1");
  });

  it("prefers __Secure-authjs.session-token when both are present", () => {
    const cookie =
      "__Secure-authjs.session-token=secure-1; authjs.session-token=plain-1";
    expect(extractSessionToken(cookie)).toBe("secure-1");
  });

  it("returns empty string for an empty cookie header", () => {
    expect(extractSessionToken("")).toBe("");
  });

  it("returns empty string when no recognised cookie is present", () => {
    expect(extractSessionToken("foo=bar; baz=qux")).toBe("");
  });

  it("handles token at end of cookie string without trailing semicolon", () => {
    expect(extractSessionToken("a=b; authjs.session-token=last")).toBe("last");
  });
});

describe("hasSessionCookie", () => {
  it("returns true when cookie header includes a recognised cookie", () => {
    expect(hasSessionCookie("authjs.session-token=tok-1")).toBe(true);
  });

  it("returns false when no recognised cookie is present", () => {
    expect(hasSessionCookie("foo=bar")).toBe(false);
  });

  it("returns false for empty cookie header", () => {
    expect(hasSessionCookie("")).toBe(false);
  });
});

describe("getSessionInfo", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGetCachedSession.mockReset();
    mockSetCachedSession.mockReset();
    mockResolveUserTenantId.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
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
    mockGetCachedSession.mockResolvedValueOnce({
      valid: true,
      userId: "u-1",
      tenantId: "t-1",
    });

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-cached" }),
    );

    expect(result).toEqual({ valid: true, userId: "u-1", tenantId: "t-1" });
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
          },
          expires: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    mockResolveUserTenantId.mockResolvedValueOnce("t-2");

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-miss" }),
    );

    expect(result.valid).toBe(true);
    expect(result.userId).toBe("u-2");
    expect(result.tenantId).toBe("t-2");
    expect(result.hasPasskey).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSetCachedSession).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: fetch throws → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-throw" }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("fail-closed: fetch returns non-OK (500) → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-500" }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("fail-closed: malformed JSON body → { valid: false }, no cache write", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-malformed" }),
    );

    expect(result).toEqual({ valid: false });
    expect(mockSetCachedSession).not.toHaveBeenCalled();
  });

  it("returns valid:false (no user) without resolving tenant when response.user is null", async () => {
    mockGetCachedSession.mockResolvedValueOnce(null);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null }), { status: 200 }),
    );

    const result = await getSessionInfo(
      makeRequest({ cookie: "authjs.session-token=tok-no-user" }),
    );

    expect(result.valid).toBe(false);
    expect(result.tenantId).toBeUndefined();
    expect(mockResolveUserTenantId).not.toHaveBeenCalled();
  });

  it("does not propagate resolveUserTenantId errors — tenantId is undefined", async () => {
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
      makeRequest({ cookie: "authjs.session-token=tok-tenant-err" }),
    );

    expect(result.valid).toBe(true);
    expect(result.userId).toBe("u-err");
    expect(result.tenantId).toBeUndefined();
    // setCachedSession is still called — tenant resolution failure must not
    // block session cache population.
    expect(mockSetCachedSession).toHaveBeenCalledTimes(1);
  });
});
