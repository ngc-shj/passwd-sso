import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  isIpInCidr,
  isIpAllowed,
  isValidCidr,
  normalizeIp,
  isTailscaleIp,
  isValidIpAddress,
  extractClientIp,
  rateLimitKeyFromIp,
  _resetTrustedProxyCache,
} from "@/lib/auth/policy/ip-access";

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

  it("rejects IPv4 with empty octets", () => {
    expect(isValidIpAddress("192.168..1")).toBe(false);
    expect(isValidIpAddress("1.2.3.")).toBe(false);
    expect(isValidIpAddress(".1.2.3")).toBe(false);
    expect(isIpInCidr("192.168..1", "192.168.0.0/16")).toBe(false);
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
  const originalProxies = process.env.TRUSTED_PROXIES;
  const originalTrustHeaders = process.env.TRUST_PROXY_HEADERS;

  beforeEach(() => {
    _resetTrustedProxyCache();
    delete process.env.TRUSTED_PROXIES;
    // NextRequest in the test env does not expose a socket peer IP, so XFF /
    // x-real-ip extraction requires the explicit opt-in. Tests that verify
    // the fail-closed path unset this flag locally.
    process.env.TRUST_PROXY_HEADERS = "true";
  });

  afterEach(() => {
    if (originalProxies !== undefined) {
      process.env.TRUSTED_PROXIES = originalProxies;
    } else {
      delete process.env.TRUSTED_PROXIES;
    }
    if (originalTrustHeaders !== undefined) {
      process.env.TRUST_PROXY_HEADERS = originalTrustHeaders;
    } else {
      delete process.env.TRUST_PROXY_HEADERS;
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

  describe("fail-closed when socket IP and opt-in are both absent", () => {
    // Simulates the default Next.js 16 runtime state: request.ip is undefined
    // and the operator has not set TRUST_PROXY_HEADERS=true. In this case
    // forwarded headers MUST be ignored — otherwise any client can spoof
    // their IP via X-Forwarded-For or X-Real-IP.
    beforeEach(() => {
      delete process.env.TRUST_PROXY_HEADERS;
      _resetTrustedProxyCache();
    });

    it("ignores x-forwarded-for without TRUST_PROXY_HEADERS opt-in", () => {
      const req = makeReq("/api/test", {
        "x-forwarded-for": "203.0.113.99",
      });
      expect(extractClientIp(req)).toBeNull();
    });

    it("ignores x-real-ip without TRUST_PROXY_HEADERS opt-in", () => {
      const req = makeReq("/api/test", {
        "x-real-ip": "203.0.113.99",
      });
      expect(extractClientIp(req)).toBeNull();
    });

    it("rejects XFF spoofing even with explicit trusted proxy CIDR", () => {
      // Without socket IP verification, TRUSTED_PROXIES alone cannot
      // distinguish a real proxy from a spoofed header.
      process.env.TRUSTED_PROXIES = "10.0.0.0/8";
      _resetTrustedProxyCache();
      const req = makeReq("/api/test", {
        "x-forwarded-for": "203.0.113.99, 10.0.0.1",
      });
      expect(extractClientIp(req)).toBeNull();
    });
  });

  // C1 (CF11) — extractClientIp returns null or a normalizeIp'd value that
  // isValidIpAddress accepts. NextRequest exposes no socket peer here, so
  // TRUST_PROXY_HEADERS=true (set in the outer beforeEach) is what makes the
  // header-derived sources (b: x-real-ip, c: XFF walk, d: all-trusted
  // leftmost) reachable through this entry point; the socket-only sources
  // (a, e) are covered in the co-located src/lib/auth/policy/ip-access.test.ts,
  // which passes an explicit socketIp.
  describe("C1 boundary validation (CF11)", () => {
    const ALLOW_ARMS: ReadonlyArray<readonly [string, string]> = [
      ["192.168.100.228", "192.168.100.228"],
      ["::ffff:192.168.100.228", "192.168.100.228"],
      ["2001:db8::1", "2001:db8::1"],
      ["[::1]", "::1"],
      ["100.64.1.2", "100.64.1.2"],
    ];

    const DENY_ARMS: readonly string[] = [
      "not-an-ip",
      "'; DROP TABLE audit_logs;--",
      "192.168.1.1:8080",
      "fe80::1%eth0",
      "192.168.001.1",
      "1e2.64.0.1",
      "::ffff:1e2.64.0.1",
      "<script>alert(1)</script>",
      "0000:0000:0000:0000:0000:ffff:255.255.255.255%25eth0",
      "unknown",
      "",
      "1:2:3:4:5:6:7:8::",
      "1:2:3:4:5:6:7:1.2.3.4",
    ];

    describe("allow arms, by value", () => {
      it.each(ALLOW_ARMS)("x-real-ip (b): %s -> %s", (raw, expected) => {
        const req = makeReq("/api/test", { "x-real-ip": raw });
        expect(extractClientIp(req)).toBe(expected);
      });

      it.each(ALLOW_ARMS)("XFF rightmost-untrusted (c): %s -> %s", (raw, expected) => {
        const req = makeReq("/api/test", { "x-forwarded-for": raw });
        expect(extractClientIp(req)).toBe(expected);
      });

      it("the rightmost-untrusted walk itself is unchanged (multi-hop)", () => {
        const req = makeReq("/api/test", {
          "x-forwarded-for": "1.2.3.4, 9.9.9.9",
        });
        expect(extractClientIp(req)).toBe("9.9.9.9");
      });
    });

    describe("deny arms — thirteen malformed/hostile values", () => {
      it.each(DENY_ARMS)("x-real-ip (b): %j -> null", (raw) => {
        const req = makeReq("/api/test", { "x-real-ip": raw });
        expect(extractClientIp(req)).toBeNull();
      });

      it.each(DENY_ARMS)("XFF rightmost-untrusted (c): %j -> null", (raw) => {
        const req = makeReq("/api/test", { "x-forwarded-for": raw });
        expect(extractClientIp(req)).toBeNull();
      });

      // As in the co-located twin: a deny value can never survive to the
      // all-trusted leftmost fallback (d) — reaching it requires every
      // walked XFF entry to have already passed the trusted-CIDR match,
      // which a malformed value always fails first, inside the walk loop.
    });
  });
});

describe("rateLimitKeyFromIp", () => {
  it("IPv4 passthrough: returns full address unchanged", () => {
    expect(rateLimitKeyFromIp("192.168.1.1")).toBe("192.168.1.1");
  });

  it("IPv4 normalizes IPv4-mapped IPv6 to plain IPv4 first", () => {
    // ::ffff:192.168.1.1 normalizes to 192.168.1.1 (no colon → passthrough)
    expect(rateLimitKeyFromIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("IPv6 full address: returns /64 prefix (first 4 groups)", () => {
    expect(rateLimitKeyFromIp("2001:db8:0:1:abc:def:0:1")).toBe(
      "2001:db8:0:1::/64",
    );
  });

  it("IPv6 abbreviated with :: expansion: returns correct /64 prefix", () => {
    // 2001:db8::1 expands to 2001:db8:0000:0000:0000:0000:0000:0001
    // First 4 groups (zero-padded as returned by the implementation): 2001:db8:0000:0000
    expect(rateLimitKeyFromIp("2001:db8::1")).toBe("2001:db8:0000:0000::/64");
  });

  it("IPv6 loopback ::1: returns correct /64 prefix", () => {
    // ::1 expands to 0000:0000:0000:0000:0000:0000:0000:0001
    // First 4 groups (zero-padded as returned by the implementation): 0000:0000:0000:0000
    expect(rateLimitKeyFromIp("::1")).toBe("0000:0000:0000:0000::/64");
  });
});
