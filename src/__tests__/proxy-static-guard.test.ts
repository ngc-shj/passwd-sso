import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock src/proxy to isolate the root proxy's static-file guard logic
vi.mock("../../src/proxy", () => ({
  proxy: () => new Response(null, { status: 200, headers: { "x-proxied": "1" } }),
}));

import { proxy } from "../../proxy";

const APP_ORIGIN = "http://localhost:3000";

function req(path: string): NextRequest {
  return new NextRequest(`${APP_ORIGIN}${path}`);
}

describe("proxy — static file guard", () => {
  it("skips /favicon.ico (static asset)", () => {
    const res = proxy(req("/favicon.ico"));
    expect(res.headers.get("x-proxied")).toBeNull();
  });

  it("skips /icon.png (static asset)", () => {
    const res = proxy(req("/icon.png"));
    expect(res.headers.get("x-proxied")).toBeNull();
  });

  it("skips /icon.svg (static asset)", () => {
    const res = proxy(req("/icon.svg"));
    expect(res.headers.get("x-proxied")).toBeNull();
  });

  it("skips /manifest.webmanifest (static asset)", () => {
    const res = proxy(req("/manifest.webmanifest"));
    expect(res.headers.get("x-proxied")).toBeNull();
  });

  it("skips /_next/static/chunk.js (Next.js internal)", () => {
    const res = proxy(req("/_next/static/chunk.js"));
    expect(res.headers.get("x-proxied")).toBeNull();
  });

  it("does NOT skip /api/passwords.json (API path)", () => {
    const res = proxy(req("/api/passwords.json"));
    expect(res.headers.get("x-proxied")).toBe("1");
  });

  it("does NOT skip /api/passwords (API path, no extension)", () => {
    const res = proxy(req("/api/passwords"));
    expect(res.headers.get("x-proxied")).toBe("1");
  });

  it("does NOT skip /api/tags (API path)", () => {
    const res = proxy(req("/api/tags"));
    expect(res.headers.get("x-proxied")).toBe("1");
  });

  it("does NOT skip /dashboard (page route)", () => {
    const res = proxy(req("/dashboard"));
    expect(res.headers.get("x-proxied")).toBe("1");
  });

  it("does NOT skip /dashboard/settings.html (non-whitelisted extension)", () => {
    // .html is not in the static file whitelist, so it passes through to the proxy
    const res = proxy(req("/dashboard/settings.html"));
    expect(res.headers.get("x-proxied")).toBe("1");
  });
});
