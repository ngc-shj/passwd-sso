import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  normalizeIp,
  rateLimitKeyFromIp,
  isIpInCidr,
  isIpAllowed,
  isValidCidr,
  isTailscaleIp,
  isValidIpAddress,
  extractClientIp,
  extractClientIpFromHeaders,
  _resetTrustedProxyCache,
} from "./ip-access";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { child: () => mockLogger },
  getLogger: () => mockLogger,
}));

beforeEach(() => {
  _resetTrustedProxyCache();
  // Clear setup.ts default that opts into trusting headers without a socket.
  vi.stubEnv("TRUST_PROXY_HEADERS", "");
  vi.stubEnv("TRUSTED_PROXIES", "127.0.0.1/32,::1/128");
});

describe("normalizeIp", () => {
  it("strips IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIp("  1.2.3.4 ")).toBe("1.2.3.4");
  });

  it("passes through plain IPv4 unchanged", () => {
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
  });

  it("passes through plain IPv6 unchanged", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("isValidCidr", () => {
  it("accepts a valid IPv4 /24", () => {
    expect(isValidCidr("192.168.0.0/24")).toBe(true);
  });

  it("rejects IPv4 with non-zero host bits (network mismatch)", () => {
    expect(isValidCidr("192.168.0.1/24")).toBe(false);
  });

  it("accepts a valid IPv6 /64", () => {
    expect(isValidCidr("2001:db8::/64")).toBe(true);
  });

  it("rejects negative or out-of-range prefix length", () => {
    expect(isValidCidr("192.168.0.0/-1")).toBe(false);
    expect(isValidCidr("192.168.0.0/33")).toBe(false);
    expect(isValidCidr("2001:db8::/129")).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(isValidCidr("not-a-cidr")).toBe(false);
    expect(isValidCidr("192.168.0.0")).toBe(false);
  });

  it("rejects IPv4 octets with leading zeros", () => {
    expect(isValidCidr("192.168.001.0/24")).toBe(false);
  });
});

describe("isIpInCidr", () => {
  it("matches IP inside an IPv4 /24", () => {
    expect(isIpInCidr("192.168.0.42", "192.168.0.0/24")).toBe(true);
  });

  it("rejects IP outside the IPv4 /24", () => {
    expect(isIpInCidr("192.168.1.42", "192.168.0.0/24")).toBe(false);
  });

  it("matches an IPv6 in a /64", () => {
    expect(isIpInCidr("2001:db8::1234", "2001:db8::/64")).toBe(true);
  });

  it("rejects an IPv6 outside the /64", () => {
    expect(isIpInCidr("2001:db9::1", "2001:db8::/64")).toBe(false);
  });

  it("does NOT match an IPv4 against an IPv6 CIDR (version mismatch)", () => {
    expect(isIpInCidr("1.2.3.4", "2001:db8::/64")).toBe(false);
  });

  it("returns false for malformed CIDR", () => {
    expect(isIpInCidr("1.2.3.4", "garbage")).toBe(false);
  });

  it("matches IPv4-mapped IPv6 against an IPv4 CIDR (after normalization)", () => {
    expect(isIpInCidr("::ffff:192.168.0.42", "192.168.0.0/24")).toBe(true);
  });
});

describe("isIpAllowed", () => {
  it("returns false on empty CIDR list (deny by default)", () => {
    expect(isIpAllowed("1.2.3.4", [])).toBe(false);
  });

  it("returns true if any CIDR matches", () => {
    expect(isIpAllowed("10.0.0.5", ["192.168.0.0/24", "10.0.0.0/8"])).toBe(true);
  });

  it("returns false when no CIDR matches", () => {
    expect(isIpAllowed("172.16.0.1", ["192.168.0.0/24", "10.0.0.0/8"])).toBe(false);
  });
});

describe("rateLimitKeyFromIp", () => {
  it("passes through IPv4 unchanged", () => {
    expect(rateLimitKeyFromIp("10.0.0.5")).toBe("10.0.0.5");
  });

  it("collapses IPv6 to /64 prefix", () => {
    expect(rateLimitKeyFromIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("handles abbreviated IPv6 with :: expansion", () => {
    // 2001:db8::1 expanded → 2001:db8:0:0:0:0:0:1 → first 4 = 2001:db8:0000:0000
    expect(rateLimitKeyFromIp("2001:db8::1")).toBe("2001:db8:0000:0000::/64");
  });
});

describe("isTailscaleIp", () => {
  it("recognizes the Tailscale IPv4 CGNAT range (100.64.0.0/10)", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
  });

  it("recognizes the Tailscale IPv6 ULA range (fd7a:115c:a1e0::/48)", () => {
    expect(isTailscaleIp("fd7a:115c:a1e0::1")).toBe(true);
  });

  it("rejects RFC1918 private addresses outside the Tailscale range", () => {
    expect(isTailscaleIp("192.168.0.1")).toBe(false);
    expect(isTailscaleIp("10.0.0.1")).toBe(false);
  });
});

describe("isValidIpAddress", () => {
  it("accepts valid IPv4", () => {
    expect(isValidIpAddress("1.2.3.4")).toBe(true);
  });

  it("rejects IPv4 with leading zeros", () => {
    expect(isValidIpAddress("01.2.3.4")).toBe(false);
  });

  it("accepts valid IPv6", () => {
    expect(isValidIpAddress("2001:db8::1")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidIpAddress("hello")).toBe(false);
    expect(isValidIpAddress("")).toBe(false);
  });
});

describe("extractClientIpFromHeaders — TRUST_PROXY_HEADERS toggle (fail-closed)", () => {
  it("returns null when no socketIp and TRUST_PROXY_HEADERS unset, even with X-Forwarded-For", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers)).toBeNull();
  });

  it("returns null when no socketIp and TRUST_PROXY_HEADERS unset, even with X-Real-IP", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const headers = new Headers({ "x-real-ip": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers)).toBeNull();
  });

  it("returns null when TRUST_PROXY_HEADERS is set to 'false'", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers)).toBeNull();
  });

  it("trusts X-Real-IP when TRUST_PROXY_HEADERS=true and no socket", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const headers = new Headers({ "x-real-ip": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers)).toBe("1.2.3.4");
  });

  it("trusts X-Forwarded-For when TRUST_PROXY_HEADERS=true and no socket", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers)).toBe("1.2.3.4");
  });

  it("returns null when neither header is present and TRUST_PROXY_HEADERS=true", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const headers = new Headers();
    expect(extractClientIpFromHeaders(headers)).toBeNull();
  });
});

describe("extractClientIpFromHeaders — socket-based path", () => {
  it("returns the socket IP and ignores XFF when socket is NOT a trusted proxy", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    const headers = new Headers({ "x-forwarded-for": "9.9.9.9" });
    // 1.2.3.4 is not in 10.0.0.0/8 → not trusted → headers ignored
    expect(extractClientIpFromHeaders(headers, "1.2.3.4")).toBe("1.2.3.4");
  });

  it("walks XFF rightmost-untrusted when socket IS a trusted proxy", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.5, 10.0.0.6" });
    // socket 10.0.0.7 trusted, walk right→left: 10.0.0.6 trusted, 10.0.0.5 trusted, 1.2.3.4 untrusted → return it
    expect(extractClientIpFromHeaders(headers, "10.0.0.7")).toBe("1.2.3.4");
  });

  it("falls back to leftmost when every XFF entry is a trusted proxy", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    const headers = new Headers({ "x-forwarded-for": "10.0.0.5, 10.0.0.6" });
    expect(extractClientIpFromHeaders(headers, "10.0.0.7")).toBe("10.0.0.5");
  });

  it("trusts X-Real-IP when socket is a trusted proxy and XFF is absent", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    const headers = new Headers({ "x-real-ip": "1.2.3.4" });
    expect(extractClientIpFromHeaders(headers, "10.0.0.7")).toBe("1.2.3.4");
  });

  it("normalizes IPv4-mapped IPv6 in the socket IP", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    // socket is ::ffff:1.2.3.4 → not in trusted CIDR (after normalize → 1.2.3.4 outside 10/8)
    expect(extractClientIpFromHeaders(new Headers(), "::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("extractClientIp (NextRequest)", () => {
  it("delegates to header-based extraction with socketIp from request.ip", () => {
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
    const req = new NextRequest("http://localhost/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.5" },
    });
    // Inject `ip` like the Next runtime does at the framework boundary.
    Object.defineProperty(req, "ip", { value: "10.0.0.6", configurable: true });
    expect(extractClientIp(req)).toBe("1.2.3.4");
  });

  it("fails closed when request.ip is undefined and TRUST_PROXY_HEADERS unset", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const req = new NextRequest("http://localhost/test", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(extractClientIp(req)).toBeNull();
  });
});
