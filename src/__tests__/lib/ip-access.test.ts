import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  isIpInCidr,
  isIpAllowed,
  isValidCidr,
  normalizeIp,
  isTailscaleIp,
  isValidIpAddress,
  extractClientIp,
  _resetTrustedProxyCache,
} from "@/lib/ip-access";

describe("normalizeIp", () => {
  it("strips IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("trims whitespace", () => {
    expect(normalizeIp("  10.0.0.1  ")).toBe("10.0.0.1");
  });

  it("returns plain IPv4 as-is", () => {
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("isValidCidr", () => {
  it("accepts valid IPv4 CIDRs", () => {
    expect(isValidCidr("192.168.1.0/24")).toBe(true);
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("0.0.0.0/0")).toBe(true);
  });

  it("rejects host bits set in network address", () => {
    expect(isValidCidr("192.168.1.1/24")).toBe(false);
  });

  it("rejects invalid prefix length", () => {
    expect(isValidCidr("192.168.1.0/33")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidCidr("not-a-cidr")).toBe(false);
    expect(isValidCidr("")).toBe(false);
  });

  it("accepts valid IPv6 CIDRs", () => {
    expect(isValidCidr("::1/128")).toBe(true);
    expect(isValidCidr("::/0")).toBe(true);
  });
});

describe("isIpInCidr", () => {
  it("matches IP within CIDR range", () => {
    expect(isIpInCidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
    expect(isIpInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
  });

  it("rejects IP outside CIDR range", () => {
    expect(isIpInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(isIpInCidr("172.16.0.1", "10.0.0.0/8")).toBe(false);
  });

  it("handles /32 single host", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(isIpInCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("handles /0 match all", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  it("handles IPv4-mapped IPv6 client IP", () => {
    expect(isIpInCidr("::ffff:192.168.1.1", "192.168.1.0/24")).toBe(true);
  });

  it("handles IPv6 CIDR matching", () => {
    expect(isIpInCidr("::1", "::1/128")).toBe(true);
    expect(isIpInCidr("::2", "::1/128")).toBe(false);
  });

  it("returns false for invalid inputs", () => {
    expect(isIpInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(isIpInCidr("10.0.0.1", "invalid")).toBe(false);
  });
});

describe("isIpAllowed", () => {
  it("returns true if any CIDR matches", () => {
    expect(
      isIpAllowed("10.0.0.5", ["192.168.1.0/24", "10.0.0.0/8"]),
    ).toBe(true);
  });

  it("returns false if no CIDR matches", () => {
    expect(
      isIpAllowed("172.16.0.1", ["192.168.1.0/24", "10.0.0.0/8"]),
    ).toBe(false);
  });

  it("returns false for empty CIDR list", () => {
    expect(isIpAllowed("10.0.0.1", [])).toBe(false);
  });
});

describe("isTailscaleIp", () => {
  it("detects Tailscale IPv4 CGNAT range", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
  });

  it("detects Tailscale IPv6 ULA range", () => {
    expect(isTailscaleIp("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailscaleIp("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")).toBe(true);
  });

  it("rejects non-Tailscale IPs", () => {
    expect(isTailscaleIp("192.168.1.1")).toBe(false);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
    expect(isTailscaleIp("fd7a:115c:a1e1::1")).toBe(false);
  });
});

describe("isValidIpAddress", () => {
  it("validates IPv4", () => {
    expect(isValidIpAddress("10.0.0.1")).toBe(true);
    expect(isValidIpAddress("255.255.255.255")).toBe(true);
  });

  it("rejects invalid IPv4", () => {
    expect(isValidIpAddress("256.0.0.1")).toBe(false);
    expect(isValidIpAddress("10.0.0")).toBe(false);
  });

  it("validates IPv6", () => {
    expect(isValidIpAddress("::1")).toBe(true);
    expect(isValidIpAddress("2001:db8::1")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidIpAddress("not-an-ip")).toBe(false);
    expect(isValidIpAddress("")).toBe(false);
  });
});

describe("extractClientIp", () => {
  const originalEnv = process.env.TRUSTED_PROXIES;

  beforeEach(() => {
    _resetTrustedProxyCache();
    delete process.env.TRUSTED_PROXIES;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TRUSTED_PROXIES = originalEnv;
    } else {
      delete process.env.TRUSTED_PROXIES;
    }
    _resetTrustedProxyCache();
  });

  function makeReq(
    path: string,
    headers?: Record<string, string>,
  ): NextRequest {
    return new NextRequest(`http://localhost${path}`, { headers });
  }

  it("returns null when no IP headers present", () => {
    const req = makeReq("/api/test");
    expect(extractClientIp(req)).toBeNull();
  });

  it("returns x-real-ip when no x-forwarded-for", () => {
    const req = makeReq("/api/test", { "x-real-ip": "198.51.100.1" });
    expect(extractClientIp(req)).toBe("198.51.100.1");
  });

  it("returns rightmost untrusted IP from x-forwarded-for", () => {
    // Default trusted: 127.0.0.1/32, ::1/128
    // XFF: client, proxy1, proxy2 — rightmost untrusted is last non-trusted
    const req = makeReq("/api/test", {
      "x-forwarded-for": "203.0.113.1, 10.0.0.1",
    });
    // Both are untrusted (not in default 127.0.0.1), rightmost untrusted = 10.0.0.1
    expect(extractClientIp(req)).toBe("10.0.0.1");
  });

  it("skips trusted proxies in x-forwarded-for", () => {
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    _resetTrustedProxyCache();

    const req = makeReq("/api/test", {
      "x-forwarded-for": "203.0.113.1, 10.0.0.1",
    });
    // 10.0.0.1 is trusted, so skip it → 203.0.113.1
    expect(extractClientIp(req)).toBe("203.0.113.1");
  });

  it("returns leftmost when all IPs are trusted", () => {
    process.env.TRUSTED_PROXIES = "0.0.0.0/0";
    _resetTrustedProxyCache();

    const req = makeReq("/api/test", {
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    });
    expect(extractClientIp(req)).toBe("10.0.0.1");
  });

  it("normalizes IPv4-mapped IPv6 in x-forwarded-for", () => {
    const req = makeReq("/api/test", {
      "x-forwarded-for": "::ffff:192.168.1.1",
    });
    expect(extractClientIp(req)).toBe("192.168.1.1");
  });

  it("handles single IP in x-forwarded-for", () => {
    const req = makeReq("/api/test", {
      "x-forwarded-for": "172.16.0.5",
    });
    expect(extractClientIp(req)).toBe("172.16.0.5");
  });
});
