import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunReadinessChecks } = vi.hoisted(() => ({
  mockRunReadinessChecks: vi.fn(),
}));

// C20: /ready now uses runReadinessChecks (excludes auditOutbox); the
// fuller runHealthChecks remains for non-readiness paths.
vi.mock("@/lib/health", () => ({
  runReadinessChecks: mockRunReadinessChecks,
}));

vi.mock("@/lib/logger", () => {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue(childLogger),
    },
    requestContext: {
      run: (_store: unknown, fn: () => unknown) => fn(),
      getStore: () => undefined,
    },
    getLogger: () => childLogger,
  };
});

import { NextRequest } from "next/server";
import { GET } from "./route";

function createRequest() {
  return new NextRequest("http://localhost/api/health/ready", {
    method: "GET",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
}

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with status=healthy only (body minimized per C20)", async () => {
    mockRunReadinessChecks.mockResolvedValue({ status: "healthy" });
    const res = await GET(createRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    // C20: body is { status } only — no checks subobject, no timestamp.
    expect(Object.keys(body).sort()).toEqual(["status"]);
    expect(body.status).toBe("healthy");
  });

  it("returns 503 when unhealthy", async () => {
    mockRunReadinessChecks.mockResolvedValue({ status: "unhealthy" });
    const res = await GET(createRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["status"]);
    expect(body.status).toBe("unhealthy");
  });

  it("sets Cache-Control: no-store header", async () => {
    mockRunReadinessChecks.mockResolvedValue({ status: "healthy" });
    const res = await GET(createRequest());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // X-Request-Id header is tested in with-request-log.test.ts
});
