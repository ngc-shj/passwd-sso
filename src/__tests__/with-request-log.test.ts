import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest } from "@/__tests__/helpers/request-builder";

// Capture log output via mocked pino
const { mockInfo, mockError, mockChild } = vi.hoisted(() => {
  const mockInfo = vi.fn();
  const mockError = vi.fn();
  const childLogger = { info: mockInfo, warn: vi.fn(), error: mockError };
  const mockChild = vi.fn().mockReturnValue(childLogger);
  return { mockInfo, mockError, mockChild };
});

vi.mock("@/lib/logger", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const requestContext = new AsyncLocalStorage();
  return {
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: mockChild,
    },
    requestContext,
    getLogger: () => requestContext.getStore() ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("withRequestLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs request.start and request.end on success", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }, { status: 200 }),
    );
    const wrapped = withRequestLog(handler);

    const req = createRequest("POST", "http://localhost:3000/api/vault/unlock");
    const response = await wrapped(req);

    // Handler was called
    expect(handler).toHaveBeenCalledOnce();

    // child() was called with requestId, method, path
    expect(mockChild).toHaveBeenCalledOnce();
    const childArgs = mockChild.mock.calls[0][0];
    expect(childArgs.requestId).toBeDefined();
    expect(typeof childArgs.requestId).toBe("string");
    expect(childArgs.method).toBe("POST");
    expect(childArgs.path).toBe("/api/vault/unlock");

    // info() called twice: request.start + request.end
    expect(mockInfo).toHaveBeenCalledTimes(2);
    expect(mockInfo.mock.calls[0][0]).toBe("request.start");

    // request.end includes status and durationMs
    const endArgs = mockInfo.mock.calls[1];
    expect(endArgs[0]).toMatchObject({ status: 200 });
    expect(typeof endArgs[0].durationMs).toBe("number");
    expect(endArgs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(endArgs[1]).toBe("request.end");

    // Response has X-Request-Id header
    expect(response.headers.get("X-Request-Id")).toBe(childArgs.requestId);
  });

  it("logs request.error and rethrows on exception", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const error = new Error("DB connection failed");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withRequestLog(handler);

    const req = createRequest("POST", "http://localhost:3000/api/passwords");

    await expect(wrapped(req)).rejects.toThrow("DB connection failed");

    // request.start was logged
    expect(mockInfo).toHaveBeenCalledOnce();
    expect(mockInfo.mock.calls[0][0]).toBe("request.start");

    // request.error was logged
    expect(mockError).toHaveBeenCalledOnce();
    const errorArgs = mockError.mock.calls[0];
    expect(errorArgs[0].err).toBe(error);
    expect(typeof errorArgs[0].durationMs).toBe("number");
    expect(errorArgs[1]).toBe("request.error");
  });

  it("sets X-Request-Id response header", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ data: "test" }),
    );
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "http://localhost:3000/api/vault/status");
    const response = await wrapped(req);

    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(UUID_RE);
  });

  it("provides request-scoped logger via getLogger() inside handler", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");
    const { getLogger } = await import("@/lib/logger");

    let loggerInsideHandler: unknown = null;

    const handler = vi.fn().mockImplementation(async () => {
      loggerInsideHandler = getLogger();
      return NextResponse.json({ ok: true });
    });

    const wrapped = withRequestLog(handler);
    const req = createRequest("POST", "http://localhost:3000/api/vault/setup");
    await wrapped(req);

    // Logger inside handler should be the child logger (has info/warn/error)
    expect(loggerInsideHandler).toBeDefined();
    expect(typeof (loggerInsideHandler as { info: unknown }).info).toBe("function");
  });

  // --- x-request-id validation ---

  it("inherits incoming x-request-id header when valid", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }),
    );
    const wrapped = withRequestLog(handler);

    const incomingId = "abc-123-incoming-id";
    const req = createRequest("GET", "http://localhost:3000/api/vault/status", {
      headers: { "x-request-id": incomingId },
    });
    const response = await wrapped(req);

    expect(response.headers.get("X-Request-Id")).toBe(incomingId);
    const childArgs = mockChild.mock.calls[0][0];
    expect(childArgs.requestId).toBe(incomingId);
  });

  it("accepts x-request-id at max length (128 chars)", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }),
    );
    const wrapped = withRequestLog(handler);

    const id128 = "a".repeat(128);
    const req = createRequest("GET", "http://localhost:3000/api/vault/status", {
      headers: { "x-request-id": id128 },
    });
    const response = await wrapped(req);

    expect(response.headers.get("X-Request-Id")).toBe(id128);
  });

  it("rejects x-request-id exceeding max length (129 chars)", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }),
    );
    const wrapped = withRequestLog(handler);

    const id129 = "a".repeat(129);
    const req = createRequest("GET", "http://localhost:3000/api/vault/status", {
      headers: { "x-request-id": id129 },
    });
    const response = await wrapped(req);

    expect(response.headers.get("X-Request-Id")).not.toBe(id129);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
  });

  it("rejects malicious x-request-id and generates a new UUID", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }),
    );
    const wrapped = withRequestLog(handler);

    const maliciousId = "evil id; DROP TABLE sessions";
    const req = createRequest("GET", "http://localhost:3000/api/vault/status", {
      headers: { "x-request-id": maliciousId },
    });
    const response = await wrapped(req);

    expect(response.headers.get("X-Request-Id")).not.toBe(maliciousId);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
  });

  it("rejects empty x-request-id header", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }),
    );
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "http://localhost:3000/api/vault/status", {
      headers: { "x-request-id": "" },
    });
    const response = await wrapped(req);

    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
  });

  // --- immutable headers ---

  it("clones response when headers are immutable (e.g. Auth.js redirect)", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const immutableResponse = Response.redirect(
      "http://localhost:3000/auth/signin",
      302,
    );

    const handler = vi.fn().mockResolvedValue(immutableResponse);
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "http://localhost:3000/api/auth/callback");
    const response = await wrapped(req);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3000/auth/signin",
    );

    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(UUID_RE);

    expect(mockInfo).toHaveBeenCalledTimes(2);
    expect(mockInfo.mock.calls[1][0]).toMatchObject({ status: 302 });
    expect(mockInfo.mock.calls[1][1]).toBe("request.end");
  });

  // --- params forwarding ---

  it("preserves handler context argument for routes with params", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const paramsPromise = Promise.resolve({ id: "entry-123" });
    const handler = vi.fn().mockImplementation(
      async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const { id } = await ctx.params;
        return NextResponse.json({ id });
      },
    );
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "http://localhost:3000/api/passwords/entry-123");
    const response = await wrapped(req, { params: paramsPromise });
    const body = await response.json();

    expect(body.id).toBe("entry-123");
    expect(handler).toHaveBeenCalledWith(req, { params: paramsPromise });
  });
});
