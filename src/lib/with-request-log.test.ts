import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockInfo, mockError, mockChild } = vi.hoisted(() => {
  const mockInfo = vi.fn();
  const mockError = vi.fn();
  const mockChild = vi.fn();
  return { mockInfo, mockError, mockChild };
});

vi.mock("@/lib/logger", async () => {
  const childLogger = { info: mockInfo, error: mockError };
  mockChild.mockReturnValue(childLogger);
  const logger = { child: mockChild };
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    default: logger,
    requestContext: new AsyncLocalStorage(),
  };
});

import { NextRequest } from "next/server";
import { withRequestLog } from "./with-request-log";

describe("withRequestLog", () => {
  beforeEach(() => {
    mockInfo.mockReset();
    mockError.mockReset();
    mockChild.mockReset();
    const childLogger = { info: mockInfo, error: mockError };
    mockChild.mockReturnValue(childLogger);
  });

  it("logs request.start and request.end on success", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withRequestLog(handler);

    const req = new NextRequest("http://localhost/api/test", { method: "GET" });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(mockChild).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/test" })
    );
    expect(mockInfo).toHaveBeenCalledWith("request.start");
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
      "request.end"
    );
  });

  it("sets X-Request-Id response header", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withRequestLog(handler);

    const req = new NextRequest("http://localhost/api/test");
    const res = await wrapped(req);

    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("uses request X-Request-Id header if present", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withRequestLog(handler);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-request-id": "custom-req-id" },
    });
    const res = await wrapped(req);

    expect(res.headers.get("X-Request-Id")).toBe("custom-req-id");
    expect(mockChild).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "custom-req-id" })
    );
  });

  it("logs request.error and rethrows on handler failure", async () => {
    const error = new Error("handler boom");
    const handler = vi.fn(async () => { throw error; });
    const wrapped = withRequestLog(handler);

    const req = new NextRequest("http://localhost/api/test");
    await expect(wrapped(req)).rejects.toThrow("handler boom");

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      "request.error"
    );
  });

  it("includes durationMs in request.end log", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const wrapped = withRequestLog(handler);

    const req = new NextRequest("http://localhost/api/test");
    await wrapped(req);

    const endCall = mockInfo.mock.calls.find((c: unknown[]) => c[1] === "request.end");
    expect(endCall).toBeDefined();
    expect(typeof endCall![0].durationMs).toBe("number");
  });
});
