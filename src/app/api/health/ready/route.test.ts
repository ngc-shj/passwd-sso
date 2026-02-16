import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunHealthChecks } = vi.hoisted(() => ({
  mockRunHealthChecks: vi.fn(),
}));

vi.mock("@/lib/health", () => ({
  runHealthChecks: mockRunHealthChecks,
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

function healthyResponse() {
  return {
    status: "healthy" as const,
    timestamp: "2026-02-16T00:00:00.000Z",
    checks: {
      database: { status: "pass" as const, responseTimeMs: 5 },
      redis: { status: "pass" as const, responseTimeMs: 2 },
    },
  };
}

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with healthy status", async () => {
    mockRunHealthChecks.mockResolvedValue(healthyResponse());
    const res = await GET(createRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.checks.database.status).toBe("pass");
    expect(body.checks.redis.status).toBe("pass");
  });

  it("returns 503 when unhealthy", async () => {
    mockRunHealthChecks.mockResolvedValue({
      ...healthyResponse(),
      status: "unhealthy",
      checks: {
        database: { status: "fail", responseTimeMs: 3000 },
        redis: { status: "pass", responseTimeMs: 2 },
      },
    });
    const res = await GET(createRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
  });

  it("returns 200 when degraded", async () => {
    mockRunHealthChecks.mockResolvedValue({
      ...healthyResponse(),
      status: "degraded",
      checks: {
        database: { status: "pass", responseTimeMs: 5 },
        redis: { status: "warn", responseTimeMs: 3000 },
      },
    });
    const res = await GET(createRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
  });

  it("sets Cache-Control: no-store header", async () => {
    mockRunHealthChecks.mockResolvedValue(healthyResponse());
    const res = await GET(createRequest());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sets X-Request-Id header", async () => {
    mockRunHealthChecks.mockResolvedValue(healthyResponse());
    const res = await GET(createRequest());
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
