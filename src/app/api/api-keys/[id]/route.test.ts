import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockPrismaApiKey,
  mockWithUserTenantRls,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaApiKey: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/session/check-auth", () => ({
  checkAuth: mockCheckAuth,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: mockPrismaApiKey,
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
  };
});
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  extractRequestMeta: () => ({}),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));

import { DELETE } from "./route";

function authFail(status = 401) {
  return {
    ok: false,
    response: NextResponse.json({ error: "UNAUTHORIZED" }, { status }),
  };
}

describe("DELETE /api/api-keys/[id]", () => {
  beforeEach(() => {
    mockCheckAuth.mockReset();
    mockPrismaApiKey.findUnique.mockReset();
    mockPrismaApiKey.update.mockReset();
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 401 for non-session auth types (token/api_key/mcp/service_account)", async () => {
    // checkAuth(req) is session-only after C2; all non-session auth types fail at the gate
    mockCheckAuth.mockResolvedValue(authFail());

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(res.status).toBe(401);
  });

  it("revokes API key for session auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findUnique.mockResolvedValue({
      id: "key-1",
      userId: "u1",
      name: "Test",
      revokedAt: null,
    });
    mockPrismaApiKey.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it("returns 403 when session step-up is required", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    // Must NOT reach DB lookup or update when step-up gate denies
    expect(mockPrismaApiKey.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaApiKey.update).not.toHaveBeenCalled();
  });

  it("returns 404 when key not found", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findUnique.mockResolvedValue(null);

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/nonexistent"),
      createParams({ id: "nonexistent" }),
    );
    expect(res.status).toBe(404);
  });

  it("calls checkAuth in session-only mode (no allowTokens option)", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(mockCheckAuth).toHaveBeenCalledWith(expect.any(NextRequest));
  });

  it("returns 404 when key belongs to another user", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findUnique.mockResolvedValue({
      id: "key-1",
      userId: "other-user",
      name: "Test",
      revokedAt: null,
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when key already revoked", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "session", userId: "u1" },
    });
    mockPrismaApiKey.findUnique.mockResolvedValue({
      id: "key-1",
      userId: "u1",
      name: "Test",
      revokedAt: new Date(),
    });

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(res.status).toBe(400);
  });
});
