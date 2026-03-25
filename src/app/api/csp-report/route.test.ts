import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWarn, mockRateLimitCheck } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/logger", () => {
  const childLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };
  return {
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnValue(childLogger) },
    requestContext: { run: (_store: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => childLogger,
  };
});

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));

import { POST } from "./route";

function createCspRequest(
  body: unknown,
  options: { contentType?: string; ip?: string } = {}
): Request {
  const {
    contentType = "application/csp-report",
    ip = "127.0.0.1",
  } = options;

  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/csp-report", () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 204 and logs sanitized csp-report", async () => {
    const res = await POST(
      createCspRequest({
        "csp-report": {
          "document-uri": "https://example.com/page?token=secret",
          "blocked-uri": "https://evil.com/script.js?k=v",
          "violated-directive": "script-src 'self'",
          "effective-directive": "script-src",
          "disposition": "enforce",
          "status-code": 200,
          "referrer": "https://example.com/prev?session=abc",
          "script-sample": "alert(1)",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(mockWarn).toHaveBeenCalledWith(
      {
        cspReport: {
          "document-uri": "https://example.com/page",
          "blocked-uri": "https://evil.com/script.js",
          "violated-directive": "script-src 'self'",
          "effective-directive": "script-src",
          disposition: "enforce",
          "status-code": 200,
        },
      },
      "csp.violation",
    );
    // referrer and script-sample are NOT in the sanitized output
    const logged = mockWarn.mock.calls[0][0].cspReport;
    expect(logged.referrer).toBeUndefined();
    expect(logged["script-sample"]).toBeUndefined();
  });

  it("strips query strings from URIs", async () => {
    const res = await POST(
      createCspRequest({
        "csp-report": {
          "document-uri": "https://app.example.com/dashboard?auth_token=xyz123&user=admin",
          "blocked-uri": "inline",
          "violated-directive": "style-src",
        },
      }),
    );
    expect(res.status).toBe(204);
    const logged = mockWarn.mock.calls[0][0].cspReport;
    expect(logged["document-uri"]).toBe("https://app.example.com/dashboard");
    expect(logged["blocked-uri"]).toBe("inline");
  });

  it("handles reports+json format", async () => {
    const res = await POST(
      createCspRequest(
        [{ type: "csp-violation", body: {
          documentURL: "https://example.com/page?t=secret",
          blockedURL: "https://cdn.example.com/lib.js",
          effectiveDirective: "script-src",
          disposition: "enforce",
        }}],
        { contentType: "application/reports+json" },
      ),
    );
    expect(res.status).toBe(204);
    expect(mockWarn).toHaveBeenCalledWith(
      {
        cspReport: {
          type: "csp-violation",
          documentURL: "https://example.com/page",
          blockedURL: "https://cdn.example.com/lib.js",
          effectiveDirective: "script-src",
          disposition: "enforce",
        },
      },
      "csp.violation",
    );
  });

  it("does not log unknown format", async () => {
    const res = await POST(
      createCspRequest({ unknownField: "data" }),
    );
    expect(res.status).toBe(204);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns 204 on unsupported content type (no logging)", async () => {
    const res = await POST(
      createCspRequest({ data: "test" }, { contentType: "text/plain" })
    );
    expect(res.status).toBe(204);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns 204 on malformed JSON body", async () => {
    const req = new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/csp-report",
        "x-forwarded-for": "127.0.0.1",
      },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns 204 silently when rate limited (no 429)", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });
    const res = await POST(
      createCspRequest({ "csp-report": { "violated-directive": "default-src" } }, { ip: "10.0.0.99" }),
    );
    expect(res.status).toBe(204);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
