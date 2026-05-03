import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  EXTENSION_TOKEN_ROUTES,
  isBearerBypassRoute,
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

describe("isBearerBypassRoute — Bearer-bypass detection truth table", () => {
  type Case = { path: string; expected: boolean; reason: string };
  const CASES: readonly Case[] = [
    // Allow (Bearer-bypass eligible)
    { path: "/api/passwords", expected: true, reason: "passwords exact" },
    { path: "/api/passwords/abc", expected: true, reason: "passwords child" },
    { path: "/api/vault/status", expected: true, reason: "vault status exact" },
    { path: "/api/vault/unlock/data", expected: true, reason: "vault unlock data exact" },
    { path: "/api/vault/unlock/data/extra", expected: true, reason: "child of vault unlock data" },
    { path: "/api/api-keys", expected: true, reason: "api-keys exact" },
    { path: "/api/api-keys/k1", expected: true, reason: "api-keys child" },
    { path: "/api/extension/token", expected: true, reason: "extension token EXACT only" },
    { path: "/api/extension/token/refresh", expected: true, reason: "extension token refresh EXACT only" },
    { path: "/api/tenant/access-requests", expected: true, reason: "SA JIT" },
    { path: "/api/vault/delegation", expected: true, reason: "vault delegation exact" },
    { path: "/api/vault/delegation/check", expected: true, reason: "vault delegation child" },

    // Deny (NOT Bearer-bypass)
    { path: "/api/teams", expected: false, reason: "teams not in list" },
    { path: "/api/tags", expected: false, reason: "tags not in list" },
    { path: "/api/notifications", expected: false, reason: "notifications not in list" },
    { path: "/api/extension/token/extra", expected: false, reason: "child of token (not in EXACT-list)" },
    { path: "/api/extension/tokenizer", expected: false, reason: "prefix-collision token vs tokenizer" },
    { path: "/api/extension/bridge-code", expected: false, reason: "non-token extension path" },
    { path: "/api/auth/session", expected: false, reason: "auth session" },
    { path: "/api/v1/passwords", expected: false, reason: "v1 has its own auth model" },
    { path: "/api/passwordsx", expected: false, reason: "passwords prefix-collision" },
  ];

  for (const tc of CASES) {
    it(`${tc.expected ? "ALLOW" : "DENY"}: ${tc.reason} (${tc.path})`, () => {
      expect(isBearerBypassRoute(tc.path)).toBe(tc.expected);
    });
  }

  it("EXTENSION_TOKEN_ROUTES is a non-empty readonly list", () => {
    expect(EXTENSION_TOKEN_ROUTES.length).toBeGreaterThan(0);
  });
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
