import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => {
  const childLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };
  return {
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnValue(childLogger) },
    requestContext: { run: (_store: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => childLogger,
  };
});

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
  });

  it("returns 204 on valid csp-report", async () => {
    const res = await POST(
      createCspRequest({ "csp-report": { "document-uri": "https://example.com" } })
    );
    expect(res.status).toBe(204);
    expect(mockWarn).toHaveBeenCalledWith(
      { cspReport: { "csp-report": { "document-uri": "https://example.com" } } },
      "csp.violation",
    );
  });

  it("returns 204 on application/reports+json content type", async () => {
    const res = await POST(
      createCspRequest([{ type: "csp-violation" }], { contentType: "application/reports+json" })
    );
    expect(res.status).toBe(204);
    expect(mockWarn).toHaveBeenCalledWith(
      { cspReport: [{ type: "csp-violation" }] },
      "csp.violation",
    );
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

  it("rate limits after exceeding max requests", async () => {
    const ip = "10.0.0.99";
    // Send 61 requests — the 61st should still return 204 (rate limited silently)
    let lastRes: Response | undefined;
    for (let i = 0; i < 61; i++) {
      lastRes = await POST(createCspRequest({ i }, { ip }));
    }
    expect(lastRes!.status).toBe(204);
  });
});
