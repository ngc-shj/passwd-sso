import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { handlePreflight, __resetAllowlistForTests } from "@/lib/http/cors";

const APP_ORIGIN = "http://localhost:3000";
// 32-char lowercase id in [a-p] range — Chrome's signing-key encoding.
const CHROME_EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CHROME_EXT_OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

function makePreflightRequest(
  url: string,
  origin: string,
  requestHeaders?: string,
): NextRequest {
  const headers: Record<string, string> = { origin };
  if (requestHeaders) {
    headers["access-control-request-headers"] = requestHeaders;
  }
  return new NextRequest(url, {
    method: "OPTIONS",
    headers,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

describe("C11 — CORS Allow-Headers includes DPoP", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preflight for exchange route from chrome-extension origin includes DPoP in Allow-Headers", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/token/exchange`,
      CHROME_EXT,
      "dpop",
    );

    const res = handlePreflight(req, { allowExtension: true });

    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders).toBeTruthy();
    // Case-insensitive check — the header value must contain "DPoP"
    expect(allowHeaders!.toLowerCase()).toContain("dpop");
  });

  it("preflight for key/reset route from chrome-extension origin includes DPoP in Allow-Headers", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/key/reset`,
      CHROME_EXT,
      "authorization, dpop",
    );

    const res = handlePreflight(req, { allowExtension: true });

    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders!.toLowerCase()).toContain("dpop");
  });

  it("same-origin preflight also includes DPoP in Allow-Headers", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/token/exchange`,
      APP_ORIGIN,
      "dpop",
    );

    const res = handlePreflight(req);

    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders!.toLowerCase()).toContain("dpop");
  });

  it("Allow-Headers also includes Content-Type and Authorization", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/token/exchange`,
      CHROME_EXT,
    );

    const res = handlePreflight(req, { allowExtension: true });

    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders!.toLowerCase()).toContain("content-type");
    expect(allowHeaders!.toLowerCase()).toContain("authorization");
    expect(allowHeaders!.toLowerCase()).toContain("dpop");
  });
});

// ─── C3: bridge-code Allow-Credentials guard ───────────────────────────────
//
// `Allow-Credentials: true` MUST be emitted for chrome-extension origins ONLY
// when (a) the request is to the bridge-code route AND (b) the origin is in
// the EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS allowlist. Bearer-bypass routes
// (extension origin without `allowExtensionCredentials`) MUST NOT receive
// Allow-Credentials — they use Bearer tokens, not cookies. See plan S17.

describe("C3 — Allow-Credentials guard for chrome-extension origin", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", CHROME_EXT);
    __resetAllowlistForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAllowlistForTests();
  });

  it("emits Allow-Credentials: true for allowlisted chrome-extension on bridge-code preflight", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/bridge-code`,
      CHROME_EXT,
      "dpop",
    );
    const res = handlePreflight(req, { allowExtensionCredentials: true });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_EXT);
  });

  it("does NOT emit any CORS headers for non-allowlisted chrome-extension on bridge-code preflight", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/bridge-code`,
      CHROME_EXT_OTHER,
      "dpop",
    );
    const res = handlePreflight(req, { allowExtensionCredentials: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("does NOT emit any CORS headers when env var is unset (fail-closed)", () => {
    vi.stubEnv("EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS", "");
    __resetAllowlistForTests();
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/bridge-code`,
      CHROME_EXT,
      "dpop",
    );
    const res = handlePreflight(req, { allowExtensionCredentials: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("does NOT emit Allow-Credentials for Bearer-bypass routes from chrome-extension (no credentials, just allowExtension)", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/token/refresh`,
      CHROME_EXT,
      "authorization, dpop",
    );
    const res = handlePreflight(req, { allowExtension: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_EXT);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("same-origin Web App preflight retains Allow-Credentials regardless", () => {
    const req = makePreflightRequest(
      `${APP_ORIGIN}/api/extension/bridge-code`,
      APP_ORIGIN,
      "content-type",
    );
    const res = handlePreflight(req, { allowExtensionCredentials: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
