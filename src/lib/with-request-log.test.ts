/**
 * Tests for withRequestLog.
 *
 * The global test setup (src/__tests__/setup.ts) mocks @/lib/with-request-log
 * with a passthrough. This file uses vi.importActual to load the real
 * implementation and vi.mock for @/lib/logger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Un-mock withRequestLog for this file so the real implementation is tested.
vi.unmock("@/lib/with-request-log");

// Hoisted mocks for @/lib/logger used by the real withRequestLog implementation.
const mocks = vi.hoisted(() => {
  const info = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();
  const reqLogger = { info, error, warn };

  // child() must return the reqLogger spy object.
  const child = vi.fn(function () {
    return reqLogger;
  });

  // requestContext.run must invoke fn() and return its result.
  const run = vi.fn(function (_logger: unknown, fn: () => unknown) {
    return fn();
  });

  return { reqLogger, child, run };
});

vi.mock("@/lib/logger", () => ({
  default: { child: mocks.child },
  requestContext: { run: mocks.run },
}));

// Import the REAL withRequestLog (not the global passthrough mock).
import { withRequestLog } from "@/lib/with-request-log";

function makeRequest(
  method = "GET",
  url = "http://localhost/api/test",
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { method, headers });
}

describe("withRequestLog", () => {
  beforeEach(() => {
    // Only clear call history — do not reset implementations.
    mocks.child.mockClear();
    mocks.run.mockClear();
    mocks.reqLogger.info.mockClear();
    mocks.reqLogger.error.mockClear();
    mocks.reqLogger.warn.mockClear();
  });

  it("returns the handler response on success", async () => {
    const handler = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const wrapped = withRequestLog(handler);
    const res = await wrapped(makeRequest());
    expect(res.status).toBe(200);
  });

  it("calls handler with forwarded arguments", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest("POST", "http://localhost/api/test");
    const context = { params: Promise.resolve({ id: "123" }) };
    await wrapped(req, context);
    expect(handler).toHaveBeenCalledWith(req, context);
  });

  it("uses X-Request-Id header if valid", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest("GET", "http://localhost/api/test", {
      "x-request-id": "valid-request-id-123",
    });
    const res = await wrapped(req);
    expect(res.headers.get("X-Request-Id")).toBe("valid-request-id-123");
  });

  it("generates a UUID when X-Request-Id is missing", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest();
    const res = await wrapped(req);
    const id = res.headers.get("X-Request-Id");
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a UUID when X-Request-Id is invalid (contains <)", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest("GET", "http://localhost/api/test", {
      "x-request-id": "<script>alert(1)</script>",
    });
    const res = await wrapped(req);
    const id = res.headers.get("X-Request-Id");
    // Should be a UUID, not the injected value
    expect(id).not.toBe("<script>alert(1)</script>");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a UUID when X-Request-Id exceeds 128 chars", async () => {
    const longId = "a".repeat(129);
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest("GET", "http://localhost/api/test", {
      "x-request-id": longId,
    });
    const res = await wrapped(req);
    const id = res.headers.get("X-Request-Id");
    expect(id).not.toBe(longId);
  });

  it("logs request.start and request.end on success", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    await wrapped(makeRequest());
    expect(mocks.reqLogger.info).toHaveBeenCalledWith("request.start");
    expect(mocks.reqLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, durationMs: expect.any(Number) }),
      "request.end",
    );
  });

  it("logs request.error and rethrows on unhandled exception", async () => {
    const err = new Error("handler failure");
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withRequestLog(handler);
    await expect(wrapped(makeRequest())).rejects.toThrow("handler failure");
    expect(mocks.reqLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err, durationMs: expect.any(Number) }),
      "request.error",
    );
  });

  it("creates child logger with requestId, method, and path", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    await wrapped(makeRequest("GET", "http://localhost/api/passwords"));
    expect(mocks.child).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        method: "GET",
        path: "/api/passwords",
      }),
    );
  });

  it("sets X-Request-Id on response", async () => {
    const handler = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const wrapped = withRequestLog(handler);
    const req = makeRequest("GET", "http://localhost/api/test", {
      "x-request-id": "my-req-id",
    });
    const res = await wrapped(req);
    expect(res.headers.get("X-Request-Id")).toBe("my-req-id");
  });

  it("handles immutable response headers by cloning the response", async () => {
    // Simulate a response with immutable headers (like Auth.js redirect)
    const immutableResponse = new Response(null, { status: 302, headers: { Location: "/login" } });
    // Make headers.set throw to simulate immutable headers
    Object.defineProperty(immutableResponse.headers, "set", {
      value: () => { throw new TypeError("immutable"); },
      configurable: true,
    });
    const handler = vi.fn().mockResolvedValue(immutableResponse);
    const wrapped = withRequestLog(handler);
    const res = await wrapped(makeRequest());
    // Should still return a response with X-Request-Id (via clone path)
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
