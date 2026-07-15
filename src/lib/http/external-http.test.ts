import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// resolve4/resolve6 are overloaded in @types/node; production code only ever
// calls the bare `(hostname: string) => Promise<string[]>` overload, so type
// the mocks against that single signature (the full `typeof` would force the
// impl to satisfy every overload).
const { mockFetch, mockResolve4, mockResolve6 } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockResolve4: vi.fn<(hostname: string) => Promise<string[]>>(
    async () => ["93.184.216.34"],
  ),
  mockResolve6: vi.fn<(hostname: string) => Promise<string[]>>(
    async () => [],
  ),
}));

vi.mock("node:dns/promises", () => ({
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

// Mock undici Agent so tests don't need real network
vi.mock("undici", () => {
  const MockAgent = vi.fn(function (this: { destroy: ReturnType<typeof vi.fn> }) {
    this.destroy = vi.fn();
  });
  return { Agent: MockAgent };
});

vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/audit/audit-logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit/audit-logger")>(
    "@/lib/audit/audit-logger",
  );
  return { ...actual };
});

vi.stubGlobal("fetch", mockFetch);

import {
  BLOCKED_CIDRS,
  BLOCKED_CIDR_REPRESENTATIVES,
  isPrivateIp,
  resolveAndValidateIps,
  validateAndFetch,
  validateAndFetchBuffered,
  sanitizeForExternalDelivery,
  sanitizeErrorForStorage,
  EXTERNAL_DELIVERY_METADATA_BLOCKLIST,
  DNS_RESOLVE_TIMEOUT_MS,
} from "./external-http";

// ─── Guard assertions ─────────────────────────────────────────────

describe("BLOCKED_CIDRS / BLOCKED_CIDR_REPRESENTATIVES", () => {
  it("BLOCKED_CIDRS has entries", () => {
    expect(BLOCKED_CIDRS.length).toBeGreaterThan(0);
  });

  it("BLOCKED_CIDR_REPRESENTATIVES length matches BLOCKED_CIDRS length", () => {
    expect(BLOCKED_CIDR_REPRESENTATIVES.length).toBe(BLOCKED_CIDRS.length);
  });
});

// ─── isPrivateIp ──────────────────────────────────────────────────

describe("isPrivateIp — representatives", () => {
  describe.each(BLOCKED_CIDR_REPRESENTATIVES)(
    "CIDR $cidr",
    ({ ipv4, ipv6 }) => {
      if (ipv4) {
        it(`IPv4 ${ipv4} is private`, () => {
          expect(isPrivateIp(ipv4)).toBe(true);
        });
      }
      if (ipv6) {
        it(`IPv6 ${ipv6} is private`, () => {
          expect(isPrivateIp(ipv6)).toBe(true);
        });
      }
    },
  );
});

describe("isPrivateIp — public IPs", () => {
  it("8.8.8.8 (Google DNS) is not private", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("2001:4860:4860::8888 (Google DNS IPv6) is not private", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });

  it("93.184.216.34 (example.com) is not private", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });
});

// ─── resolveAndValidateIps ────────────────────────────────────────

describe("resolveAndValidateIps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
  });

  it("IP literal (public) returns [ip] without DNS lookup", async () => {
    const result = await resolveAndValidateIps("https://93.184.216.34/path");
    expect(result).toEqual(["93.184.216.34"]);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("a hung DNS resolver is bounded by DNS_RESOLVE_TIMEOUT_MS, not blocked indefinitely", async () => {
    vi.useFakeTimers();
    try {
      // Both A and AAAA lookups hang forever — without the timeout wrapper this
      // would never settle, letting a slow resolver blow the caller's wall-clock
      // budget (the webhook lease bound depends on this being bounded).
      mockResolve4.mockReturnValue(new Promise<string[]>(() => {}));
      mockResolve6.mockReturnValue(new Promise<string[]>(() => {}));

      const promise = resolveAndValidateIps("https://slow-dns.example.com/path");
      const assertion = expect(promise).rejects.toThrow(/DNS resolution failed|timed out/i);
      // A and AAAA each run under their own DNS_RESOLVE_TIMEOUT_MS deadline; both
      // hang, so advancing past the (shared-duration) deadline trips both and the
      // empty-ips path throws "DNS resolution failed".
      await vi.advanceTimersByTimeAsync(DNS_RESOLVE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fast A record is USED even when AAAA hangs to its own timeout (one-family survival)", async () => {
    vi.useFakeTimers();
    try {
      // A resolves immediately with a public IPv4; AAAA hangs forever. Because
      // each lookup has its OWN timeout (not one shared deadline around the pair),
      // the good A result must survive the AAAA hang — a shared timeout would
      // reject the whole thing and discard the usable IPv4.
      mockResolve4.mockResolvedValue(["93.184.216.34"]);
      mockResolve6.mockReturnValue(new Promise<string[]>(() => {}));

      const promise = resolveAndValidateIps("https://half-hung.example.com/path");
      // Let the immediate A resolution settle, then advance past the AAAA deadline.
      await vi.advanceTimersByTimeAsync(DNS_RESOLVE_TIMEOUT_MS + 1);
      await expect(promise).resolves.toEqual(["93.184.216.34"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("IP literal (private) throws 'Private IP rejected'", async () => {
    await expect(
      resolveAndValidateIps("https://192.168.1.1/path"),
    ).rejects.toThrow("Private IP rejected");
  });

  it("IPv4-mapped IPv6 literal in hex form is rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://[::ffff:7f00:1]/path"),
    ).rejects.toThrow("Private IP rejected");
  });

  it("uppercase IPv4-mapped IPv6 literal in hex form is rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://[::FFFF:7F00:1]/path"),
    ).rejects.toThrow("Private IP rejected");
  });

  it("zero-padded IPv4-mapped IPv6 literal in hex form is rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://[::ffff:7f00:0001]/path"),
    ).rejects.toThrow("Private IP rejected");
  });

  // M3 regression — non-canonical IPv4 literals that an attacker might use
  // to dodge a naive `/^[\d.]+$/` check. Node's URL parser canonicalizes
  // these to dotted-quad before parsed.hostname is read, so isPrivateIp
  // catches the loopback variants directly. The hex / 32-bit-decimal /
  // octal forms are exercised here to PIN THE BEHAVIOR — if a future Node
  // upgrade ever stops canonicalizing them, the defense-in-depth
  // `net.isIP()` check kicks in and these tests should switch to asserting
  // "Malformed IP literal rejected" instead.
  it("M3: octal IPv4 literal (0177.0.0.1) is canonicalized to 127.0.0.1 and rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://0177.0.0.1/path"),
    ).rejects.toThrow("Private IP rejected");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("M3: hex IPv4 literal (0x7f.0.0.1) is canonicalized and rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://0x7f.0.0.1/path"),
    ).rejects.toThrow("Private IP rejected");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("M3: 32-bit decimal IPv4 literal (2130706433) is canonicalized and rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://2130706433/path"),
    ).rejects.toThrow("Private IP rejected");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("M3: partial IPv4 form (127.1) is canonicalized to 127.0.0.1 and rejected as private", async () => {
    await expect(
      resolveAndValidateIps("https://127.1/path"),
    ).rejects.toThrow("Private IP rejected");
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("hostname resolving to public IP returns IPs", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
    const result = await resolveAndValidateIps("https://example.com/path");
    expect(result).toContain("93.184.216.34");
  });

  it("hostname resolving to private IP throws", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.1"]);
    mockResolve6.mockResolvedValue([]);
    await expect(
      resolveAndValidateIps("https://evil.example.com/path"),
    ).rejects.toThrow("private IP");
  });

  it("hostname resolving to hex-form IPv4-mapped IPv6 loopback throws", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(["::ffff:7f00:1"]);
    await expect(
      resolveAndValidateIps("https://evil.example.com/path"),
    ).rejects.toThrow("private IP");
  });

  it("hostname resolving to uppercase hex-form IPv4-mapped IPv6 loopback throws", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(["::FFFF:7F00:1"]);
    await expect(
      resolveAndValidateIps("https://evil.example.com/path"),
    ).rejects.toThrow("private IP");
  });

  it("hostname resolving to zero-padded hex-form IPv4-mapped IPv6 loopback throws", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(["::ffff:7f00:0001"]);
    await expect(
      resolveAndValidateIps("https://evil.example.com/path"),
    ).rejects.toThrow("private IP");
  });

  it("hostname with no DNS records throws 'DNS resolution failed'", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    await expect(
      resolveAndValidateIps("https://nxdomain.example.com/"),
    ).rejects.toThrow("DNS resolution failed");
  });

  it("hostname where both DNS resolvers reject (throw) also throws", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      resolveAndValidateIps("https://nxdomain.example.com/"),
    ).rejects.toThrow("DNS resolution failed");
  });

  it("non-HTTP scheme throws 'Unsupported URL scheme'", async () => {
    await expect(
      resolveAndValidateIps("file:///etc/passwd"),
    ).rejects.toThrow("Unsupported URL scheme");
  });

  it("ftp:// scheme throws 'Unsupported URL scheme'", async () => {
    await expect(
      resolveAndValidateIps("ftp://example.com/file"),
    ).rejects.toThrow("Unsupported URL scheme");
  });
});

// ─── validateAndFetch ─────────────────────────────────────────────

describe("validateAndFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
  });

  afterEach(() => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
  });

  it("happy path: resolves DNS, fetches with redirect: 'error'", async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    mockFetch.mockResolvedValue(mockResponse);

    const result = await validateAndFetch("https://example.com/endpoint", {
      method: "POST",
      body: "{}",
    });

    expect(result).toBe(mockResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/endpoint");
    expect(opts.redirect).toBe("error");
    expect(opts.headers["User-Agent"]).toBe("passwd-sso-delivery/1.0");
  });

  it("passes caller headers alongside User-Agent", async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);

    await validateAndFetch("https://example.com/endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["User-Agent"]).toBe("passwd-sso-delivery/1.0");
  });

  it("SSRF blocked: private IP literal throws", async () => {
    await expect(
      validateAndFetch("https://10.0.0.1/evil", { method: "GET" }),
    ).rejects.toThrow("Private IP rejected");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("SSRF blocked: hostname resolving to private IP throws", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    await expect(
      validateAndFetch("https://metadata.evil.com/", { method: "GET" }),
    ).rejects.toThrow("private IP");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── validateAndFetchBuffered ─────────────────────────────────────

describe("validateAndFetchBuffered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
  });

  // Build a Response-like whose body is a real ReadableStream of `bytes`, so the
  // helper exercises the shared readStreamWithCap (getReader) path — the body is
  // read BEFORE the helper's finally destroys the pinned dispatcher. (The plain
  // validateAndFetch returns the Response and destroys the dispatcher
  // immediately, so a caller reading the body afterwards hits
  // ClientDestroyedError — the bug this helper fixes.)
  function streamingResponse(bytes: Uint8Array, contentType: string) {
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "content-type" ? contentType : null) },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  it("reads the body and returns ok/status/contentType/body", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValue(streamingResponse(bytes, "image/png"));

    const result = await validateAndFetchBuffered("https://example.com/favicon", {
      maxBytes: 1024,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(Uint8Array.from(result.body)).toEqual(bytes);
  });

  it("throws RangeError when the body exceeds maxBytes", async () => {
    mockFetch.mockResolvedValue(streamingResponse(new Uint8Array(2048), "image/png"));

    await expect(
      validateAndFetchBuffered("https://example.com/favicon", { maxBytes: 1024 }),
    ).rejects.toThrow(RangeError);
  });

  it("SSRF blocked: hostname resolving to private IP throws, no fetch", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    await expect(
      validateAndFetchBuffered("https://metadata.evil.com/", { maxBytes: 1024 }),
    ).rejects.toThrow("private IP");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── sanitizeForExternalDelivery ──────────────────────────────────

describe("sanitizeForExternalDelivery", () => {
  it("strips blocklisted keys from flat object", () => {
    const input = {
      email: "user@example.com",
      targetUserEmail: "target@example.com",
      reason: "some reason",
      incidentRef: "INC-001",
      displayName: "Alice",
      justification: "emergency",
      requestedScope: "credentials:list",
      entryId: "entry-1",
    };
    const result = sanitizeForExternalDelivery(input) as Record<string, unknown>;
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("targetUserEmail");
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("incidentRef");
    expect(result).not.toHaveProperty("displayName");
    expect(result).not.toHaveProperty("justification");
    expect(result).not.toHaveProperty("requestedScope");
    expect(result).toHaveProperty("entryId", "entry-1");
  });

  it("strips METADATA_BLOCKLIST keys (crypto keys)", () => {
    const input = {
      password: "secret123",
      token: "tok-abc",
      accessToken: "at-xyz",
      refreshToken: "rt-xyz",
      webhookId: "wh-1",
    };
    const result = sanitizeForExternalDelivery(input) as Record<string, unknown>;
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
    expect(result).toHaveProperty("webhookId", "wh-1");
  });

  it("strips blocklisted keys from nested objects recursively", () => {
    const input = {
      outer: "keep",
      nested: {
        email: "should-strip",
        inner: {
          token: "strip-too",
          safe: "keep-this",
        },
      },
    };
    const result = sanitizeForExternalDelivery(input) as Record<string, unknown>;
    expect(result).toHaveProperty("outer", "keep");
    const nested = result["nested"] as Record<string, unknown>;
    expect(nested).not.toHaveProperty("email");
    const inner = nested["inner"] as Record<string, unknown>;
    expect(inner).not.toHaveProperty("token");
    expect(inner).toHaveProperty("safe", "keep-this");
  });

  it("preserves non-blocklisted keys", () => {
    const input = { entryId: "e-1", userId: "u-1", action: "ENTRY_CREATE" };
    const result = sanitizeForExternalDelivery(input) as Record<string, unknown>;
    expect(result).toEqual({ entryId: "e-1", userId: "u-1", action: "ENTRY_CREATE" });
  });

  it("handles arrays by sanitizing each element", () => {
    const input = [
      { email: "a@example.com", id: "1" },
      { email: "b@example.com", id: "2" },
    ];
    const result = sanitizeForExternalDelivery(input) as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).not.toHaveProperty("email");
    expect(result[0]).toHaveProperty("id", "1");
    expect(result[1]).not.toHaveProperty("email");
    expect(result[1]).toHaveProperty("id", "2");
  });

  it("handles null and undefined", () => {
    expect(sanitizeForExternalDelivery(null)).toBeNull();
    expect(sanitizeForExternalDelivery(undefined)).toBeUndefined();
  });

  it("returns primitives unchanged", () => {
    expect(sanitizeForExternalDelivery("string")).toBe("string");
    expect(sanitizeForExternalDelivery(42)).toBe(42);
    expect(sanitizeForExternalDelivery(true)).toBe(true);
  });

  it("EXTERNAL_DELIVERY_METADATA_BLOCKLIST is a superset of METADATA_BLOCKLIST items", () => {
    // email and other PII keys must be present
    expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has("email")).toBe(true);
    expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has("displayName")).toBe(true);
    expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has("reason")).toBe(true);
    // crypto keys from METADATA_BLOCKLIST must also be present
    expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has("password")).toBe(true);
    expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has("token")).toBe(true);
  });
});

// ─── sanitizeErrorForStorage ──────────────────────────────────────

describe("sanitizeErrorForStorage", () => {
  it("strips URL query params containing credentials", () => {
    const input = "Request failed: https://example.com?token=abc123&foo=bar";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("https://example.com/");
    expect(result).toContain("[query params redacted]");
    expect(result).not.toContain("token=abc123");
  });

  it("strips Bearer tokens", () => {
    const input = "Authorization: Bearer abc123def456";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123def456");
  });

  it("strips Splunk tokens", () => {
    const input = "Authorization: Splunk mytoken12345";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mytoken12345");
  });

  it("strips Basic auth credentials", () => {
    const input = "Authorization: Basic dXNlcjpwYXNz";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("dXNlcjpwYXNz");
  });

  it("strips AWS4-HMAC-SHA256 credentials", () => {
    const input = "Authorization: AWS4-HMAC-SHA256 Credential=AKID/20230101/us-east-1/s3/aws4_request";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKID/20230101");
  });

  it("truncates message to maxLength (default 1024)", () => {
    const longMessage = "a".repeat(2000);
    const result = sanitizeErrorForStorage(longMessage);
    expect(result.length).toBe(1024);
  });

  it("truncates message to custom maxLength", () => {
    const longMessage = "b".repeat(500);
    const result = sanitizeErrorForStorage(longMessage, 100);
    expect(result.length).toBe(100);
  });

  it("preserves clean messages unchanged", () => {
    const clean = "Connection timeout after 10000ms";
    const result = sanitizeErrorForStorage(clean);
    expect(result).toBe(clean);
  });

  it("does not modify URLs without query params", () => {
    const input = "Request to https://example.com/path failed";
    const result = sanitizeErrorForStorage(input);
    expect(result).toContain("https://example.com/path");
    expect(result).not.toContain("[query params redacted]");
  });

  it("strips secret and api_key query params", () => {
    const input = "https://api.example.com/endpoint?api_key=supersecret&page=1";
    const result = sanitizeErrorForStorage(input);
    expect(result).not.toContain("supersecret");
    expect(result).toContain("[query params redacted]");
  });
});
