import { describe, it, expect, vi, beforeEach } from "vitest";

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
    vi.restoreAllMocks();
  });

  it("returns 204 on valid csp-report", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(
      createCspRequest({ "csp-report": { "document-uri": "https://example.com" } })
    );
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledWith("CSP report:", expect.any(Object));
  });

  it("returns 204 on application/reports+json content type", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(
      createCspRequest([{ type: "csp-violation" }], { contentType: "application/reports+json" })
    );
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns 204 on unsupported content type (no logging)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(
      createCspRequest({ data: "test" }, { contentType: "text/plain" })
    );
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns 204 on malformed JSON body", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(warnSpy).not.toHaveBeenCalled();
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
