import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockSessionFindUnique,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { requireRecentSession, STEP_UP_WINDOW_MS } from "./step-up";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie },
  });
}

describe("requireRecentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown, _purpose: string) => fn(),
    );
  });

  it("returns null when the session was created within the allowed window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS + 30_000),
    });

    const result = await requireRecentSession(makeRequest());
    expect(result).toBeNull();
  });

  it("returns 403 when the session is stale", async () => {
    mockSessionFindUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 30_000),
    });

    const result = await requireRecentSession(makeRequest());
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "SESSION_STEP_UP_REQUIRED",
    });
  });

  it("returns 401 when the request has no session cookie", async () => {
    const result = await requireRecentSession(makeRequest(""));
    expect(result?.status).toBe(401);
  });

  it("returns 401 when the session row does not exist", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentSession(makeRequest());
    expect(result?.status).toBe(401);
  });
});
