import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  BEARER_BYPASS_ROUTE_SUMMARY,
  isBearerBypassRoute,
  isBearerBypassPath,
  isExtensionExchangeRoute,
  handleApiPreflight,
  applyCorsHeaders,
} from "./cors-gate";

const APP_ORIGIN = "http://localhost:3000";
const EVIL_ORIGIN = "http://evil.com";
// Plausible chrome-extension origin (32 lowercase letters).
const EXT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

function makeRequest(
  path: string,
  method: string = "GET",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`, { method, headers });
}

describe("isBearerBypassRoute — method + exact-path truth table", () => {
  type Case = { path: string; method: string; expected: boolean; reason: string };
  const CASES: readonly Case[] = [
    // ── ALLOW (method + exact-path in the allowlist) ──
    { path: "/api/passwords", method: "GET", expected: true, reason: "passwords list read" },
    { path: "/api/passwords", method: "POST", expected: true, reason: "passwords create" },
    { path: "/api/passwords/abc", method: "GET", expected: true, reason: "single entry read" },
    { path: "/api/passwords/abc", method: "PUT", expected: true, reason: "single entry update" },
    { path: "/api/passwords/abc", method: "DELETE", expected: true, reason: "single entry soft-delete (extension passkey-replace)" },
    { path: "/api/teams", method: "GET", expected: true, reason: "team list read" },
    { path: "/api/teams/t1/member-key", method: "GET", expected: true, reason: "team member-key read" },
    { path: "/api/teams/t1/passwords", method: "GET", expected: true, reason: "team passwords list read" },
    { path: "/api/teams/t1/passwords/e1", method: "GET", expected: true, reason: "single team entry read" },
    { path: "/api/vault/status", method: "GET", expected: true, reason: "vault status" },
    { path: "/api/vault/unlock/data", method: "GET", expected: true, reason: "vault unlock data" },
    { path: "/api/vault/delegation/check", method: "GET", expected: true, reason: "CLI agent delegation check" },
    { path: "/api/vault/ssh/sign-authorize", method: "POST", expected: true, reason: "CLI SSH sign-authorize" },
    { path: "/api/extension/token", method: "DELETE", expected: true, reason: "extension token revoke" },
    { path: "/api/extension/token/refresh", method: "POST", expected: true, reason: "extension token refresh" },
    { path: "/api/extension/key/reset", method: "POST", expected: true, reason: "extension key reset" },
    { path: "/api/tenant/access-requests", method: "POST", expected: true, reason: "SA JIT create" },

    // ── DENY: wrong method on an allowed path ──
    { path: "/api/teams", method: "POST", expected: false, reason: "team create is session-only (wrong method)" },
    { path: "/api/teams/t1/passwords/e1", method: "DELETE", expected: false, reason: "team entry delete is session-only (wrong method)" },
    { path: "/api/teams/t1/passwords", method: "POST", expected: false, reason: "team entry create is session-only (wrong method)" },
    { path: "/api/passwords/abc", method: "PATCH", expected: false, reason: "no PATCH on single entry" },
    { path: "/api/vault/unlock/data", method: "POST", expected: false, reason: "vault unlock data is GET-only" },
    { path: "/api/tenant/access-requests", method: "GET", expected: false, reason: "access-requests GET is session-only" },
    { path: "/api/vault/ssh/sign-authorize", method: "GET", expected: false, reason: "sign-authorize is POST-only" },

    // ── DENY: mutating children no longer Bearer-reachable (was the M2/M3 bug) ──
    { path: "/api/passwords/bulk-import", method: "POST", expected: false, reason: "bulk-import is session-only (FLIP: was Bearer-reachable)" },
    { path: "/api/passwords/bulk-import", method: "GET", expected: false, reason: "subroute literal must not collide with single-entry [id] GET" },
    { path: "/api/passwords/generate", method: "GET", expected: false, reason: "generate subroute must not collide with [id] GET" },
    { path: "/api/teams/t1/passwords/bulk-import", method: "GET", expected: false, reason: "team subroute literal must not collide with single-entry [id] GET" },
    { path: "/api/passwords/empty-trash", method: "POST", expected: false, reason: "empty-trash is session-only" },
    { path: "/api/passwords/abc/attachments", method: "PUT", expected: false, reason: "attachments are session-only" },
    { path: "/api/passwords/abc/history", method: "GET", expected: false, reason: "history is session-only" },
    { path: "/api/teams/t1/passwords/bulk-import", method: "POST", expected: false, reason: "team bulk-import is session-only (FLIP: was Bearer-reachable)" },
    { path: "/api/teams/t1/passwords/empty-trash", method: "POST", expected: false, reason: "team empty-trash is session-only" },

    // ── DENY: narrowed paths that prefix-matching used to allow ──
    { path: "/api/vault/unlock/data/extra", method: "GET", expected: false, reason: "no child wildcard (FLIP: was Bearer-reachable)" },
    { path: "/api/vault/delegation", method: "POST", expected: false, reason: "delegation parent is session-only (FLIP: was Bearer-reachable)" },
    { path: "/api/vault/delegation", method: "GET", expected: false, reason: "only /check is Bearer; parent is session-only" },
    { path: "/api/teams/t1/member-key/extra", method: "GET", expected: false, reason: "member-key is leaf-exact" },
    { path: "/api/teams/t1/passwordsX", method: "GET", expected: false, reason: "suffix collision — exact segment boundary" },
    { path: "/api/teams-export", method: "GET", expected: false, reason: "sibling collision — not under /api/teams/" },
    { path: "/api/extension/token/extra", method: "DELETE", expected: false, reason: "extension token is exact only" },
    { path: "/api/extension/tokenizer", method: "DELETE", expected: false, reason: "prefix collision — token vs tokenizer" },

    // ── DENY: never-Bearer routes ──
    { path: "/api/teams/t1", method: "GET", expected: false, reason: "team CRUD — web-only" },
    { path: "/api/teams/t1/webhooks", method: "GET", expected: false, reason: "web-only sensitive config" },
    { path: "/api/api-keys", method: "GET", expected: false, reason: "api-keys session-only" },
    { path: "/api/tags", method: "GET", expected: false, reason: "tags not Bearer" },
    { path: "/api/extension/bridge-code", method: "POST", expected: false, reason: "exchange route handled separately" },
    { path: "/api/v1/passwords", method: "GET", expected: false, reason: "v1 has its own auth model" },
    { path: "/api/passwordsx", method: "GET", expected: false, reason: "passwords prefix collision" },
  ];

  for (const tc of CASES) {
    it(`${tc.expected ? "ALLOW" : "DENY"}: ${tc.method} ${tc.path} — ${tc.reason}`, () => {
      expect(isBearerBypassRoute(tc.path, tc.method)).toBe(tc.expected);
    });
  }

  it("BEARER_BYPASS_ROUTE_SUMMARY is a non-empty readonly list", () => {
    expect(BEARER_BYPASS_ROUTE_SUMMARY.length).toBeGreaterThan(0);
  });
});

describe("isBearerBypassPath — path-only (any-method) for OPTIONS preflight", () => {
  // True when ANY method is allowed for the path (preflight grants CORS, not auth).
  type Case = { path: string; expected: boolean; reason: string };
  const CASES: readonly Case[] = [
    { path: "/api/passwords", expected: true, reason: "GET/POST allowed" },
    { path: "/api/passwords/abc", expected: true, reason: "GET/PUT/DELETE allowed" },
    { path: "/api/teams/t1/passwords", expected: true, reason: "GET allowed" },
    { path: "/api/extension/token", expected: true, reason: "DELETE allowed" },
    { path: "/api/tenant/access-requests", expected: true, reason: "POST allowed (any-method semantics)" },
    { path: "/api/passwords/bulk-import", expected: false, reason: "no method allowed" },
    { path: "/api/teams/t1/webhooks", expected: false, reason: "never-Bearer path" },
    { path: "/api/passwordsx", expected: false, reason: "prefix collision" },
    { path: "/api/vault/delegation", expected: false, reason: "only /check leaf is Bearer" },
  ];

  for (const tc of CASES) {
    it(`${tc.expected ? "ELIGIBLE" : "NOT"}: ${tc.path} — ${tc.reason}`, () => {
      expect(isBearerBypassPath(tc.path)).toBe(tc.expected);
    });
  }
});

describe("isExtensionExchangeRoute", () => {
  it("matches exactly /api/extension/token/exchange", () => {
    expect(isExtensionExchangeRoute("/api/extension/token/exchange")).toBe(true);
  });

  it("rejects child paths of the exchange route", () => {
    expect(isExtensionExchangeRoute("/api/extension/token/exchange/extra")).toBe(false);
  });

  it("rejects unrelated paths", () => {
    expect(isExtensionExchangeRoute("/api/extension/token")).toBe(false);
    expect(isExtensionExchangeRoute("/api/passwords")).toBe(false);
  });
});

describe("handleApiPreflight — OPTIONS preflight wiring", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 204 with CORS headers when same-origin request", () => {
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: APP_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("returns 204 WITHOUT CORS headers for cross-origin (evil.com)", () => {
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: EVIL_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 204 WITHOUT CORS headers when Origin header is missing", () => {
    const req = makeRequest("/api/passwords", "OPTIONS");
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does NOT reflect attacker-supplied origin (reflective-origin guard)", () => {
    // Attacker sends `Origin: http://evil.com` hoping for reflection.
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: EVIL_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe(EVIL_ORIGIN);
  });

  it("allows chrome-extension origin on Bearer-bypass routes", () => {
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: EXT_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(EXT_ORIGIN);
  });

  it("allows chrome-extension origin on exchange route", () => {
    const req = makeRequest("/api/extension/token/exchange", "OPTIONS", { origin: EXT_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: false, isExchangeRoute: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(EXT_ORIGIN);
  });

  it("REJECTS chrome-extension origin on routes that are NEITHER Bearer-bypass NOR exchange", () => {
    const req = makeRequest("/api/teams", "OPTIONS", { origin: EXT_ORIGIN });
    const res = handleApiPreflight(req, { isBearerRoute: false, isExchangeRoute: false });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("REJECTS malformed chrome-extension origin (wrong id length)", () => {
    const malformed = `chrome-extension://${"a".repeat(10)}`;
    const req = makeRequest("/api/passwords", "OPTIONS", { origin: malformed });
    const res = handleApiPreflight(req, { isBearerRoute: true, isExchangeRoute: false });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("applyCorsHeaders — same-exit-point header application", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches CORS headers to existing NextResponse for same-origin", () => {
    const req = makeRequest("/api/passwords", "GET", { origin: APP_ORIGIN });
    const res = NextResponse.json({ ok: true });
    applyCorsHeaders(req, res);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("does not attach CORS headers for cross-origin", () => {
    const req = makeRequest("/api/passwords", "GET", { origin: EVIL_ORIGIN });
    const res = NextResponse.json({ ok: true });
    applyCorsHeaders(req, res);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("merges Vary header (preserves existing)", () => {
    const req = makeRequest("/api/passwords", "GET", { origin: APP_ORIGIN });
    const res = NextResponse.json({ ok: true });
    res.headers.set("Vary", "Accept-Encoding");
    applyCorsHeaders(req, res);
    const vary = res.headers.get("Vary") ?? "";
    expect(vary.toLowerCase()).toContain("accept-encoding");
    expect(vary.toLowerCase()).toContain("origin");
  });
});
