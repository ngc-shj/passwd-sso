import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { handlePreflight, applyCorsHeaders } from "./cors";

// ─── Helpers ─────────────────────────────────────────────────

function makeRequest(origin?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

// ─── handlePreflight ─────────────────────────────────────────

describe("handlePreflight", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 204 with CORS headers for same-origin request", () => {
    process.env.APP_URL = "http://localhost:3000";
    const res = handlePreflight(makeRequest("http://localhost:3000"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("returns 204 without CORS headers for cross-origin request", () => {
    process.env.APP_URL = "http://localhost:3000";
    const res = handlePreflight(makeRequest("http://evil.com"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 204 without CORS headers when origin is absent", () => {
    process.env.APP_URL = "http://localhost:3000";
    const res = handlePreflight(makeRequest());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 204 without CORS headers when APP_URL is not set", () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    const res = handlePreflight(makeRequest("http://localhost:3000"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("falls back to AUTH_URL when APP_URL is not set", () => {
    delete process.env.APP_URL;
    process.env.AUTH_URL = "http://localhost:3000";
    const res = handlePreflight(makeRequest("http://localhost:3000"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });
});

// ─── applyCorsHeaders ────────────────────────────────────────

describe("applyCorsHeaders", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("applies CORS headers to existing response for same-origin", () => {
    process.env.APP_URL = "http://localhost:3000";
    const req = makeRequest("http://localhost:3000");
    const res = NextResponse.json({ ok: true });
    const result = applyCorsHeaders(req, res);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("merges Vary header without duplicating Origin", () => {
    process.env.APP_URL = "http://localhost:3000";
    const req = makeRequest("http://localhost:3000");
    const res = NextResponse.json({ ok: true });
    res.headers.set("Vary", "Accept-Encoding");
    const result = applyCorsHeaders(req, res);
    const vary = result.headers.get("Vary") ?? "";
    expect(vary).toContain("Accept-Encoding");
    expect(vary).toContain("Origin");
  });

  it("does not add CORS headers for cross-origin", () => {
    process.env.APP_URL = "http://localhost:3000";
    const req = makeRequest("http://evil.com");
    const res = NextResponse.json({ ok: true });
    const result = applyCorsHeaders(req, res);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not duplicate Origin in Vary if already present", () => {
    process.env.APP_URL = "http://localhost:3000";
    const req = makeRequest("http://localhost:3000");
    const res = NextResponse.json({ ok: true });
    res.headers.set("Vary", "Origin, Accept-Encoding");
    const result = applyCorsHeaders(req, res);
    const vary = result.headers.get("Vary") ?? "";
    const originCount = vary.split("Origin").length - 1;
    expect(originCount).toBe(1);
  });
});
