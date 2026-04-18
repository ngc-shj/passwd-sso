import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockCheckAuth,
  mockPrismaApiKey,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
  mockPrismaApiKey: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/check-auth", () => ({
  checkAuth: mockCheckAuth,
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
vi.mock("@/lib/audit", () => ({
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

  it("returns 401 when auth type is api_key", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: {
        type: "api_key",
        userId: "u1",
        tenantId: "t1",
        apiKeyId: "ak1",
        scopes: ["passwords:read"],
      },
    });

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

  it("revokes API key for extension token auth", async () => {
    mockCheckAuth.mockResolvedValue({
      ok: true,
      auth: { type: "token", userId: "u1", scopes: [] },
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

  it("calls checkAuth with allowTokens and skipAccessRestriction", async () => {
    mockCheckAuth.mockResolvedValue(authFail());

    await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/api-keys/key-1"),
      createParams({ id: "key-1" }),
    );
    expect(mockCheckAuth).toHaveBeenCalledWith(
      expect.any(NextRequest),
      { allowTokens: true, skipAccessRestriction: true },
    );
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
