import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { isIP } from "node:net";
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
import { AUDIT_IP_MAX_LENGTH } from "@/lib/validations/common.server";

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

  it("normalizes hex-form IPv4-mapped IPv6 to dotted IPv4", () => {
    expect(normalizeIp("::ffff:7f00:1")).toBe("127.0.0.1");
  });

  it("normalizes uppercase hex-form IPv4-mapped IPv6 to dotted IPv4", () => {
    expect(normalizeIp("::FFFF:7F00:1")).toBe("127.0.0.1");
  });

  it("normalizes zero-padded hex-form IPv4-mapped IPv6 to dotted IPv4", () => {
    expect(normalizeIp("::ffff:7f00:0001")).toBe("127.0.0.1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIp("  1.2.3.4 ")).toBe("1.2.3.4");
  });

  it("strips IPv6 literal brackets", () => {
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("normalizes bracketed hex-form IPv4-mapped IPv6 to dotted IPv4", () => {
    expect(normalizeIp("[::ffff:7f00:1]")).toBe("127.0.0.1");
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

  it("matches hex-form IPv4-mapped IPv6 against an IPv4 CIDR", () => {
    expect(isIpInCidr("::ffff:7f00:1", "127.0.0.0/8")).toBe(true);
  });

  it("matches uppercase hex-form IPv4-mapped IPv6 against an IPv4 CIDR", () => {
    expect(isIpInCidr("::FFFF:7F00:1", "127.0.0.0/8")).toBe(true);
  });

  it("matches zero-padded hex-form IPv4-mapped IPv6 against an IPv4 CIDR", () => {
    expect(isIpInCidr("::ffff:7f00:0001", "127.0.0.0/8")).toBe(true);
  });

  // RFC 4291 §2.2 form 3 is not only the ::ffff: spelling. Before the parser
  // handled the general case, any other prefix written with a dotted-quad tail
  // failed to parse and therefore matched NO CIDR at all — a silent miss for
  // the SSRF blocklist and an unexplained deny for tenant allowlists.
  it("matches a non-::ffff: address written with a dotted-quad tail", () => {
    expect(isIpInCidr("64:ff9b::169.254.169.254", "64:ff9b::/96")).toBe(true);
  });

  it("does not let a dotted-quad tail match an unrelated IPv6 prefix", () => {
    expect(isIpInCidr("64:ff9b::100.64.0.1", "fd7a:115c:a1e0::/48")).toBe(false);
  });

  it("agrees with the hex spelling of the same address", () => {
    expect(isIpInCidr("::127.0.0.1", "::/96")).toBe(
      isIpInCidr("::7f00:1", "::/96"),
    );
  });

  it("rejects an over-long address whose dotted tail would overflow 16 bytes", () => {
    expect(isIpInCidr("1:2:3:4:5:6:7:8:9.10.11.12", "::/0")).toBe(false);
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

  // The pre-filter regex and parseIpv6 have to agree on which spellings exist.
  // While the filter rejected any dot, this returned false for an address the
  // CIDR matchers accept — a validator disagreeing with the parser it guards.
  it("accepts an IPv6 address written with a dotted-quad tail", () => {
    expect(isValidIpAddress("64:ff9b::169.254.169.254")).toBe(true);
  });

  it("rejects a dotted fragment that is not a valid address", () => {
    expect(isValidIpAddress("1.2:0:0:0:0:0:0:1")).toBe(false);
  });

  it("rejects junk", () => {
    expect(isValidIpAddress("hello")).toBe(false);
    expect(isValidIpAddress("")).toBe(false);
  });

  // net.isIP is the authority on what an address IS; this parser only decides
  // which CIDR one falls in. Where the two disagree, a string nobody can route
  // gets classified anyway — `::ffff:1e2.64.0.1` normalized into the Tailscale
  // CGNAT range because Number("1e2") is 100. Asserted as a property so a
  // future spelling cannot reopen the gap one case at a time.
  it.each([
    "1.2.3.4",
    "255.255.255.255",
    "2001:db8::1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::169.254.169.254",
    "fd7a:115c:a1e0::1234",
    "1:2:3:4:5:6:7:8",
    // Forms net.isIP rejects
    "1:2:3:4:5:6:7:8::",
    "::ffff:1e2.0.0.1",
    "::ffff:1e2.64.0.1",
    "::ffff:0x7f.0.0.1",
    "1.2:0:0:0:0:0:0:1",
    "01.2.3.4",
    "1.2.3.4.5",
    "256.1.1.1",
    "1.2.3",
    "hello",
    "",
  ])("agrees with net.isIP on %j", (candidate) => {
    expect(isValidIpAddress(candidate)).toBe(isIP(candidate) !== 0);
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

// #1 regression: the production ECS/ALB config is TRUST_PROXY_HEADERS=true with
// TRUSTED_PROXIES UNSET (loopback only) — the VPC CIDR is deliberately NOT
// trusted. The ALB APPENDS the connection source IP to any client XFF, so the
// rightmost hop is always the one the ALB actually observed. A VPC-internal
// attacker therefore cannot spoof another client's IP. (Trusting the VPC CIDR —
// the earlier bug — would strip the ALB hop and surface the forged leftmost
// value.)
describe("extractClientIpFromHeaders — ALB XFF spoof resistance (#1)", () => {
  beforeEach(() => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("TRUSTED_PROXIES", "127.0.0.1/32,::1/128"); // VPC NOT trusted
  });

  it("does NOT return an attacker-forged leftmost XFF value (returns the ALB-observed source)", () => {
    // Attacker inside the VPC sends `XFF: <spoof>`; the ALB APPENDS the IP it
    // observed on the connection (here the attacker's own 10.0.1.25 — the ALB
    // appends the connection source, NOT some fixed ALB IP). So the rightmost
    // entry is that observed source, never the forged leftmost value.
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.77, 10.0.1.25",
    });
    const ip = extractClientIpFromHeaders(headers);
    expect(ip).not.toBe("198.51.100.77"); // spoof rejected
    expect(ip).toBe("10.0.1.25"); // the hop the ALB actually observed
  });

  it("returns the real client IP for the standard single-hop ALB XFF", () => {
    // AWS ALB's normal behavior: XFF = the single real client IP.
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
    expect(extractClientIpFromHeaders(headers)).toBe("203.0.113.9");
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

// ─── C1 (CF11) — the boundary validates every value it can return ─────
//
// extractClientIpFromHeaders has five value sources (plan C1): (a) the
// socket-not-trusted early return, (b) x-real-ip, (c) the rightmost-untrusted
// XFF walk, (d) the all-trusted leftmost fallback, (e) the all-trusted raw
// socketIp fallback. All five must return null or a normalizeIp'd value that
// isValidIpAddress accepts. This tree passes an explicit socketIp, so it is
// the only one that can reach (a) and (e) directly.
describe("extractClientIpFromHeaders — C1 boundary validation (CF11)", () => {
  beforeEach(() => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
  });

  // [raw, expected-normalized] — F1's over-rejection guard (allow direction).
  const ALLOW_ARMS: ReadonlyArray<readonly [string, string]> = [
    ["192.168.100.228", "192.168.100.228"],
    ["::ffff:192.168.100.228", "192.168.100.228"],
    ["2001:db8::1", "2001:db8::1"],
    ["[::1]", "::1"],
    ["100.64.1.2", "100.64.1.2"],
  ];

  // Rejected → null, not stripped/coerced (port suffix, zone id, SQLi/XSS
  // payloads, octal-looking octets, the "1e2" Number() coercion trap, an
  // over-long IPv6 form, and a malformed dotted-quad tail).
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
    it.each(ALLOW_ARMS)("socket-not-trusted (a): %s -> %s", (raw, expected) => {
      // TRUSTED_PROXIES=10.0.0.0/8 does not cover any of these socket values.
      expect(extractClientIpFromHeaders(new Headers(), raw)).toBe(expected);
    });

    it.each(ALLOW_ARMS)("x-real-ip (b), socket trusted: %s -> %s", (raw, expected) => {
      const headers = new Headers({ "x-real-ip": raw });
      expect(extractClientIpFromHeaders(headers, "10.0.0.1")).toBe(expected);
    });

    it.each(ALLOW_ARMS)("XFF rightmost-untrusted (c), socket trusted: %s -> %s", (raw, expected) => {
      const headers = new Headers({ "x-forwarded-for": raw });
      expect(extractClientIpFromHeaders(headers, "10.0.0.1")).toBe(expected);
    });

    it("the rightmost-untrusted walk itself is unchanged (multi-hop)", () => {
      const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.5" });
      expect(extractClientIpFromHeaders(headers, "10.0.0.6")).toBe("1.2.3.4");
    });

    // Forbidden pattern #2's witness (plan C1): TRUSTED_PROXIES=::1/128,
    // socket "[::1]" (bracketed, as a caller might supply it), XFF "," (all
    // entries blank so `leftmost` is undefined and the raw socketIp is used).
    // Reaching this fallback REQUIRES the socket to already be a trusted,
    // parseable address (see the deny-arms note below) — so its only
    // observable bug is a raw/normalized formatting mismatch, not a bogus
    // value slipping through. Pre-fix this returned "[::1]" verbatim, which
    // isValidIpAddress rejects outright (brackets are not a valid IPv6
    // character); post-fix it is normalized like every other source.
    it("all-trusted fallback via the raw socket IP (e) normalizes bracketed input", () => {
      vi.stubEnv("TRUSTED_PROXIES", "::1/128");
      const headers = new Headers({ "x-forwarded-for": "," });
      expect(extractClientIpFromHeaders(headers, "[::1]")).toBe("::1");
    });
  });

  describe("deny arms — thirteen malformed/hostile values", () => {
    it.each(DENY_ARMS)("socket-not-trusted (a): %j -> null", (raw) => {
      expect(extractClientIpFromHeaders(new Headers(), raw)).toBeNull();
    });

    it.each(DENY_ARMS)("x-real-ip (b), socket trusted: %j -> null", (raw) => {
      const headers = new Headers({ "x-real-ip": raw });
      expect(extractClientIpFromHeaders(headers, "10.0.0.1")).toBeNull();
    });

    it.each(DENY_ARMS)("XFF rightmost-untrusted (c), socket trusted: %j -> null", (raw) => {
      const headers = new Headers({ "x-forwarded-for": raw });
      expect(extractClientIpFromHeaders(headers, "10.0.0.1")).toBeNull();
    });

    // Sources (d) (all-trusted leftmost) and (e) (all-trusted raw socketIp)
    // only run their return line once every walked XFF entry has ALREADY
    // passed the trusted-CIDR match, which itself requires parseIpv4/parseIpv6
    // success — any of the thirteen deny values fails that match and is
    // therefore always returned earlier: as the socket-not-trusted early
    // return (a) when it is the socket value, or from inside the walk loop
    // itself (c) when it is an XFF entry, the same instant it is found
    // untrusted. None of the thirteen can reach the post-loop fallback
    // lines, so there is no separate (d)/(e) deny case to assert — (e)'s
    // only reachable behaviour is the formatting-mismatch case above.
  });
});

// I1.2 — a non-null return is at most AUDIT_IP_MAX_LENGTH (45) characters.
describe("extractClientIpFromHeaders — I1.2 length bound", () => {
  beforeEach(() => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    vi.stubEnv("TRUSTED_PROXIES", "10.0.0.0/8");
  });

  it("the widest non-mapped witness is exactly 45 characters and passes through unchanged", () => {
    // NOT the IPv4-mapped form (below) — this one has a non-zero high half,
    // so normalizeIp does not collapse it to a bare IPv4 address.
    const witness = "2001:0db8:0000:0000:0000:0000:255.255.255.255";
    expect(witness.length).toBe(AUDIT_IP_MAX_LENGTH);
    const headers = new Headers({ "x-real-ip": witness });
    const result = extractClientIpFromHeaders(headers, "10.0.0.1");
    expect(result).toBe(witness);
    expect(result!.length).toBeLessThanOrEqual(AUDIT_IP_MAX_LENGTH);
  });

  it("the IPv4-mapped form normalizes down to 15 characters, not 45", () => {
    const mapped = "0000:0000:0000:0000:0000:ffff:255.255.255.255";
    expect(normalizeIp(mapped)).toBe("255.255.255.255");
    expect(normalizeIp(mapped).length).toBe(15);
  });
});

// isIpInCidr parity (CFP4) — the property that makes F1 literal: normalizing
// before the call must be a no-op, over both an allow-shaped and a
// deny-shaped input set, and over both address families.
describe("isIpInCidr parity (CFP4)", () => {
  const V4_CIDR = "192.168.0.0/16";
  const V6_CIDR = "2001:db8::/32";
  const CASES: readonly string[] = [
    "192.168.100.228",
    "::ffff:192.168.100.228",
    "2001:db8::1",
    "[::1]",
    "100.64.1.2",
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

  it.each(CASES)("v4 CIDR: isIpInCidr(%j) === isIpInCidr(normalizeIp(%j))", (raw) => {
    expect(isIpInCidr(raw, V4_CIDR)).toBe(isIpInCidr(normalizeIp(raw), V4_CIDR));
  });

  it.each(CASES)("v6 CIDR: isIpInCidr(%j) === isIpInCidr(normalizeIp(%j))", (raw) => {
    expect(isIpInCidr(raw, V6_CIDR)).toBe(isIpInCidr(normalizeIp(raw), V6_CIDR));
  });
});

// F1's permanent guard — a committed table, not a scratchpad probe.
// normalizeIp/isValidIpAddress/isIpAllowed/isTailscaleIp are exported, pure,
// and unmodified by C1: no value the boundary nulls can satisfy any of their
// allow arms, before or after this change. Measured against the widest
// possible CIDR set so a false pass cannot hide behind a narrow allowlist.
describe("F1 permanent guard — a boundary-nulled value never reaches an allow arm", () => {
  const WIDEST_CIDRS = ["0.0.0.0/0", "::/0"];
  const BOUNDARY_NULLED: readonly string[] = [
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

  it.each(BOUNDARY_NULLED)("%j never satisfies isIpAllowed under the widest CIDR set", (raw) => {
    expect(isIpAllowed(raw, WIDEST_CIDRS)).toBe(false);
  });

  it.each(BOUNDARY_NULLED)("%j is never classified as a Tailscale peer", (raw) => {
    expect(isTailscaleIp(raw)).toBe(false);
  });

  it.each(BOUNDARY_NULLED)("%j never matches an all-encompassing CIDR of either family", (raw) => {
    expect(isIpInCidr(raw, "0.0.0.0/0")).toBe(false);
    expect(isIpInCidr(raw, "::/0")).toBe(false);
  });
});
