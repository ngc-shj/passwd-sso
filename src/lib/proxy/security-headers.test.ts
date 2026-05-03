import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { applySecurityHeaders } from "./security-headers";
import { PERMISSIONS_POLICY } from "@/lib/security/security-headers";

const dummyOptions = { cspHeader: "default-src 'self'", nonce: "n0nc3-XYZ" };

describe("applySecurityHeaders", () => {
  it("sets Content-Security-Policy from cspHeader option", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets X-Content-Type-Options: nosniff", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets Permissions-Policy from shared SSoT constant", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY);
  });

  it("omits Strict-Transport-Security when not over HTTPS (default test env)", () => {
    // setup.ts does not set AUTH_URL → isHttps default-false. Documents the
    // current shape: HSTS is off in plain-HTTP dev/test contexts.
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("includes basePath in Report-To and Reporting-Endpoints CSP report URLs", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions, "/passwd-sso");
    const reportTo = JSON.parse(res.headers.get("Report-To") ?? "{}") as {
      endpoints?: { url?: string }[];
    };
    expect(reportTo.endpoints?.[0]?.url).toBe("/passwd-sso/api/csp-report");
    expect(res.headers.get("Reporting-Endpoints")).toBe(
      'csp-endpoint="/passwd-sso/api/csp-report"',
    );
  });

  it("uses root path for CSP report endpoint when basePath is empty", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    const reportTo = JSON.parse(res.headers.get("Report-To") ?? "{}") as {
      endpoints?: { url?: string }[];
    };
    expect(reportTo.endpoints?.[0]?.url).toBe("/api/csp-report");
  });

  it("sets csp-nonce cookie with nonce value, httpOnly + sameSite=lax", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions);
    const cookie = res.cookies.get("csp-nonce");
    expect(cookie?.value).toBe("n0nc3-XYZ");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
  });

  it("propagates a different nonce on each call (no caching of nonce)", () => {
    const res1 = applySecurityHeaders(new NextResponse(), {
      cspHeader: "default-src 'self'",
      nonce: "first-nonce",
    });
    const res2 = applySecurityHeaders(new NextResponse(), {
      cspHeader: "default-src 'self'",
      nonce: "second-nonce",
    });
    expect(res1.cookies.get("csp-nonce")?.value).toBe("first-nonce");
    expect(res2.cookies.get("csp-nonce")?.value).toBe("second-nonce");
  });

  it("scopes csp-nonce cookie path to basePath when provided", () => {
    const res = applySecurityHeaders(new NextResponse(), dummyOptions, "/passwd-sso");
    expect(res.cookies.get("csp-nonce")?.path).toBe("/passwd-sso/");
  });

  it("returns the same response object passed in (mutation-style API)", () => {
    const res = new NextResponse();
    const result = applySecurityHeaders(res, dummyOptions);
    expect(result).toBe(res);
  });
});
