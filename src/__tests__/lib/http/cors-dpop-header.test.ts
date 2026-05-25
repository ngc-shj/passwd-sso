import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { handlePreflight } from "@/lib/http/cors";

const APP_ORIGIN = "http://localhost:3000";
const CHROME_EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

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
