import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
  mockValidateExtensionToken,
  mockEnforceAccessRestriction,
  mockFindUnique,
  mockUpdate,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
}));

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));

vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { findUnique: mockFindUnique, update: mockUpdate } }),
    user: { findUnique: mockFindUnique, update: mockUpdate },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withTenantRls: async (
    _prisma: unknown,
    _tenantId: string,
    fn: (tx: {
      user: {
        findUnique: typeof mockFindUnique;
        update: typeof mockUpdate;
      };
    }) => Promise<unknown>,
  ) => fn({ user: { findUnique: mockFindUnique, update: mockUpdate } }),
}));

import { GET, PUT } from "./route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

function makeGetReq() {
  return createRequest("GET", "https://example.test/api/mobile/favicon-pref", {
    headers: {
      authorization: "DPoP access-token-here",
      dpop: "fake.proof",
    },
  });
}

function makePutReq(body: unknown) {
  return createRequest("PUT", "https://example.test/api/mobile/favicon-pref", {
    body,
    headers: {
      authorization: "DPoP access-token-here",
      dpop: "fake.proof",
    },
  });
}

function authOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      tokenId: TOKEN_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      clientKind: "IOS_APP" as const,
      scopes: ["passwords:read"],
      expiresAt: new Date("2099-01-01"),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      ...overrides,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/mobile/favicon-pref", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExtensionToken.mockResolvedValue(authOk());
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockFindUnique.mockResolvedValue({ fetchFavicons: true });
  });

  it("returns 401 when token is invalid", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });
    const { status } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(401);
  });

  it("returns 403 when clientKind is not IOS_APP", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      authOk({ clientKind: "BROWSER_EXTENSION" }),
    );
    const { status } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(403);
  });

  it("returns the access-restriction denial when tenant IP policy rejects", async () => {
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const { status, json } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(403);
    expect(json.error).toBe("ACCESS_DENIED");
  });

  it("returns the current fetchFavicons preference (true)", async () => {
    mockFindUnique.mockResolvedValue({ fetchFavicons: true });
    const { status, json } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(200);
    expect(json).toEqual({ fetchFavicons: true });
  });

  it("returns fetchFavicons=false when user has opted out", async () => {
    mockFindUnique.mockResolvedValue({ fetchFavicons: false });
    const { status, json } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(200);
    expect(json).toEqual({ fetchFavicons: false });
  });

  it("returns fetchFavicons=false when user row is null", async () => {
    mockFindUnique.mockResolvedValue(null);
    const { status, json } = await parseResponse(await GET(makeGetReq()));
    expect(status).toBe(200);
    expect(json).toEqual({ fetchFavicons: false });
  });
});

describe("PUT /api/mobile/favicon-pref", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateExtensionToken.mockResolvedValue(authOk());
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockUpdate.mockResolvedValue({ fetchFavicons: true });
  });

  it("returns 401 when token is invalid", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_INVALID",
    });
    const { status } = await parseResponse(await PUT(makePutReq({ fetchFavicons: true })));
    expect(status).toBe(401);
  });

  it("returns 403 when clientKind is not IOS_APP", async () => {
    mockValidateExtensionToken.mockResolvedValue(
      authOk({ clientKind: "IOS_AUTOFILL" }),
    );
    const { status } = await parseResponse(await PUT(makePutReq({ fetchFavicons: true })));
    expect(status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns the access-restriction denial when tenant IP policy rejects", async () => {
    mockEnforceAccessRestriction.mockResolvedValue(
      NextResponse.json({ error: "ACCESS_DENIED" }, { status: 403 }),
    );
    const { status } = await parseResponse(await PUT(makePutReq({ fetchFavicons: true })));
    expect(status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("persists fetchFavicons=true and returns the new value", async () => {
    const { status, json } = await parseResponse(
      await PUT(makePutReq({ fetchFavicons: true })),
    );
    expect(status).toBe(200);
    expect(json).toEqual({ fetchFavicons: true });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: { fetchFavicons: true },
      }),
    );
  });

  it("persists fetchFavicons=false and returns the new value", async () => {
    const { status, json } = await parseResponse(
      await PUT(makePutReq({ fetchFavicons: false })),
    );
    expect(status).toBe(200);
    expect(json).toEqual({ fetchFavicons: false });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fetchFavicons: false },
      }),
    );
  });

  it("rejects non-boolean fetchFavicons → 400", async () => {
    const { status } = await parseResponse(
      await PUT(makePutReq({ fetchFavicons: "yes" })),
    );
    expect(status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects unknown field (Zod strict) → 400", async () => {
    const { status, json } = await parseResponse(
      await PUT(makePutReq({ fetchFavicons: true, extra: "shouldntbehere" })),
    );
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects missing fetchFavicons field → 400", async () => {
    const { status } = await parseResponse(await PUT(makePutReq({})));
    expect(status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
