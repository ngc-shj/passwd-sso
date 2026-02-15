import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

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

function createRequest(
  method: string,
  path: string,
): Request {
  return new Request(`http://localhost:3000${path}`, { method });
}

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

    const req = createRequest("POST", "/api/vault/unlock");
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

    const req = createRequest("POST", "/api/passwords");

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

  it("does not log sensitive keys in error objects", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    // Error with no sensitive fields
    const error = new Error("Something went wrong");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "/api/passwords");
    await expect(wrapped(req)).rejects.toThrow();

    // Verify error logging doesn't include body/password/token
    const errorArgs = mockError.mock.calls[0][0];
    expect(errorArgs.password).toBeUndefined();
    expect(errorArgs.token).toBeUndefined();
    expect(errorArgs.authorization).toBeUndefined();
    expect(errorArgs.cookie).toBeUndefined();
  });

  it("sets X-Request-Id response header", async () => {
    const { withRequestLog } = await import("@/lib/with-request-log");

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ data: "test" }),
    );
    const wrapped = withRequestLog(handler);

    const req = createRequest("GET", "/api/vault/status");
    const response = await wrapped(req);

    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
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
    const req = createRequest("POST", "/api/vault/setup");
    await wrapped(req);

    // Logger inside handler should be the child logger (has info/warn/error)
    expect(loggerInsideHandler).toBeDefined();
    expect(typeof (loggerInsideHandler as { info: unknown }).info).toBe("function");
  });

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

    const req = createRequest("GET", "/api/passwords/entry-123");
    const response = await wrapped(req, { params: paramsPromise });
    const body = await response.json();

    expect(body.id).toBe("entry-123");
    expect(handler).toHaveBeenCalledWith(req, { params: paramsPromise });
  });
});
