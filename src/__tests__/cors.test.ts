import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { handlePreflight, applyCorsHeaders } from "@/lib/cors";

const APP_ORIGIN = "http://localhost:3000";
const CROSS_ORIGIN = "http://evil.com";

function makeRequest(
  method: string,
  origin?: string,
): NextRequest {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new NextRequest("http://localhost:3000/api/passwords", {
    method,
    headers,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

describe("cors", () => {
  beforeEach(() => {
    vi.stubEnv("APP_URL", APP_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── handlePreflight ────────────────────────────────────────

  describe("handlePreflight", () => {
    it("returns 204 with CORS headers for same-origin", () => {
      const res = handlePreflight(makeRequest("OPTIONS", APP_ORIGIN));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
      expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Authorization",
      );
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("returns 204 without CORS headers for cross-origin", () => {
      const res = handlePreflight(makeRequest("OPTIONS", CROSS_ORIGIN));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("returns 204 without CORS headers when Origin is absent", () => {
      const res = handlePreflight(makeRequest("OPTIONS"));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("returns 204 without CORS headers when APP_URL is not set", () => {
      vi.stubEnv("APP_URL", "");
      delete process.env.AUTH_URL;

      const res = handlePreflight(makeRequest("OPTIONS", APP_ORIGIN));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("returns 204 without CORS headers when APP_URL is invalid", () => {
      vi.stubEnv("APP_URL", "not-a-url");

      const res = handlePreflight(makeRequest("OPTIONS", APP_ORIGIN));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("falls back to AUTH_URL when APP_URL is not set", () => {
      vi.stubEnv("APP_URL", "");
      vi.stubEnv("AUTH_URL", APP_ORIGIN);

      const res = handlePreflight(makeRequest("OPTIONS", APP_ORIGIN));

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    });
  });

  // ─── applyCorsHeaders ──────────────────────────────────────

  describe("applyCorsHeaders", () => {
    it("adds CORS headers for same-origin request", () => {
      const req = makeRequest("GET", APP_ORIGIN);
      const res = applyCorsHeaders(req, NextResponse.next());

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
      expect(res.headers.get("Vary")).toBe("Origin");
    });

    it("does not add CORS headers for cross-origin request", () => {
      const req = makeRequest("GET", CROSS_ORIGIN);
      const res = applyCorsHeaders(req, NextResponse.next());

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("does not add CORS headers when Origin is absent", () => {
      const req = makeRequest("GET");
      const res = applyCorsHeaders(req, NextResponse.next());

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("preserves existing Vary header and appends Origin", () => {
      const req = makeRequest("GET", APP_ORIGIN);
      const response = NextResponse.next();
      response.headers.set("Vary", "Accept-Encoding");

      const res = applyCorsHeaders(req, response);

      expect(res.headers.get("Vary")).toBe("Accept-Encoding, Origin");
    });

    it("deduplicates Vary tokens case-insensitively", () => {
      const req = makeRequest("GET", APP_ORIGIN);
      const response = NextResponse.next();
      response.headers.set("Vary", "origin");

      const res = applyCorsHeaders(req, response);

      // Should keep existing casing, not add duplicate
      expect(res.headers.get("Vary")).toBe("origin");
    });

    it("does not duplicate Vary: Origin on double invocation", () => {
      const req = makeRequest("GET", APP_ORIGIN);
      let res = applyCorsHeaders(req, NextResponse.next());
      res = applyCorsHeaders(req, res);

      const varyTokens = (res.headers.get("Vary") ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase());
      const originCount = varyTokens.filter((t) => t === "origin").length;
      expect(originCount).toBe(1);
    });
  });
});
