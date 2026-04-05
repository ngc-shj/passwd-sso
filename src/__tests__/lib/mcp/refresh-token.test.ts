import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRefreshToken,
  exchangeRefreshToken,
} from "@/lib/mcp/oauth-server";
import { MCP_REFRESH_TOKEN_PREFIX, MCP_TOKEN_PREFIX } from "@/lib/constants/mcp";

// ─── Mock Prisma ──────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/crypto-server", () => ({
  hashToken: vi.fn((token: string) => `hashed:${token}`),
}));

// ─── createRefreshToken tests ─────────────────────────────────

describe("createRefreshToken", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { prisma } = await import("@/lib/prisma");
    (prisma as Record<string, unknown>).mcpRefreshToken = {
      create: vi.fn().mockResolvedValue({ id: "rt-uuid" }),
    };
  });

  it("returns a refresh token with mcpr_ prefix", async () => {
    const result = await createRefreshToken({
      accessTokenId: "access-token-id",
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      userId: "user-uuid",
      scope: "credentials:list,credentials:use",
    });

    expect(result.refreshToken).toMatch(new RegExp(`^${MCP_REFRESH_TOKEN_PREFIX}`));
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stores hash in DB (not plaintext token)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockCreate = vi.fn().mockResolvedValue({ id: "rt-uuid" });
    (prisma as Record<string, unknown>).mcpRefreshToken = { create: mockCreate };

    const result = await createRefreshToken({
      accessTokenId: "access-token-id",
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      scope: "credentials:list,credentials:use",
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0].data;
    // tokenHash must not equal the plaintext token
    expect(callArgs.tokenHash).not.toBe(result.refreshToken);
    // Hash is computed via hashToken mock: "hashed:<token>"
    expect(callArgs.tokenHash).toBe(`hashed:${result.refreshToken}`);
  });

  it("generates a new familyId when not provided", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockCreate = vi.fn().mockResolvedValue({ id: "rt-uuid" });
    (prisma as Record<string, unknown>).mcpRefreshToken = { create: mockCreate };

    await createRefreshToken({
      accessTokenId: "access-token-id",
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      scope: "credentials:list,credentials:use",
    });

    const callArgs = mockCreate.mock.calls[0][0].data;
    expect(callArgs.familyId).toBeTruthy();
    expect(typeof callArgs.familyId).toBe("string");
  });

  it("uses the provided familyId when given (for rotation)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const mockCreate = vi.fn().mockResolvedValue({ id: "rt-uuid" });
    (prisma as Record<string, unknown>).mcpRefreshToken = { create: mockCreate };

    const existingFamilyId = "existing-family-uuid";
    await createRefreshToken({
      accessTokenId: "access-token-id",
      clientId: "client-uuid",
      tenantId: "tenant-uuid",
      scope: "credentials:list,credentials:use",
      familyId: existingFamilyId,
    });

    const callArgs = mockCreate.mock.calls[0][0].data;
    expect(callArgs.familyId).toBe(existingFamilyId);
  });
});

// ─── exchangeRefreshToken tests ───────────────────────────────

describe("exchangeRefreshToken", () => {
  const VALID_CLIENT = {
    id: "client-db-uuid",
    clientId: "mcpc_testclient",
    clientSecretHash: "hashed:correct-secret",
    isActive: true,
  };

  const VALID_RT = {
    id: "rt-db-uuid",
    tokenHash: "hashed:valid-refresh-token",
    familyId: "family-uuid-123",
    accessTokenId: "old-access-token-id",
    clientId: "client-db-uuid",
    tenantId: "tenant-uuid-123",
    userId: "user-uuid-123",
    serviceAccountId: null,
    scope: "credentials:list,credentials:use",
    expiresAt: new Date(Date.now() + 3600000),
    revokedAt: null,
    rotatedAt: null,
    mcpClient: VALID_CLIENT,
  };

  function setupPrisma(overrides: {
    rt?: typeof VALID_RT | null;
    newAccessCreate?: jest.Mock | ReturnType<typeof vi.fn>;
    newRefreshCreate?: jest.Mock | ReturnType<typeof vi.fn>;
    refreshUpdateMany?: ReturnType<typeof vi.fn>;
    refreshFindMany?: ReturnType<typeof vi.fn>;
    accessUpdateMany?: ReturnType<typeof vi.fn>;
    refreshUpdate?: ReturnType<typeof vi.fn>;
  } = {}) {
    return import("@/lib/prisma").then(({ prisma }) => {
      const newAccessId = "new-access-token-id";
      const mockAccessCreate = overrides.newAccessCreate ?? vi.fn().mockResolvedValue({ id: newAccessId });
      const mockRefreshCreate = overrides.newRefreshCreate ?? vi.fn().mockResolvedValue({ id: "new-rt-id" });
      const mockRefreshUpdateMany = overrides.refreshUpdateMany ?? vi.fn().mockResolvedValue({});
      const mockRefreshFindMany = overrides.refreshFindMany ?? vi.fn().mockResolvedValue([
        { accessTokenId: VALID_RT.accessTokenId },
      ]);
      const mockAccessUpdateMany = overrides.accessUpdateMany ?? vi.fn().mockResolvedValue({});
      const mockRefreshUpdate = overrides.refreshUpdate ?? vi.fn().mockResolvedValue({});

      (prisma as Record<string, unknown>).$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
      (prisma as Record<string, unknown>).mcpRefreshToken = {
        findUnique: vi.fn().mockResolvedValue(overrides.rt !== undefined ? overrides.rt : VALID_RT),
        updateMany: mockRefreshUpdateMany,
        findMany: mockRefreshFindMany,
        create: mockRefreshCreate,
        update: mockRefreshUpdate,
      };
      const mockAccessUpdate = vi.fn().mockResolvedValue({});
      (prisma as Record<string, unknown>).mcpAccessToken = {
        create: mockAccessCreate,
        update: mockAccessUpdate,
        updateMany: mockAccessUpdateMany,
      };

      return {
        mockAccessCreate,
        mockRefreshCreate,
        mockRefreshUpdateMany,
        mockRefreshFindMany,
        mockAccessUpdateMany,
        mockRefreshUpdate,
      };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: returns new access token and refresh token pair", async () => {
    await setupPrisma();

    const result = await exchangeRefreshToken({
      refreshToken: "valid-refresh-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessToken).toMatch(new RegExp(`^${MCP_TOKEN_PREFIX}`));
      expect(result.refreshToken).toMatch(new RegExp(`^${MCP_REFRESH_TOKEN_PREFIX}`));
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.scope).toBe("credentials:list,credentials:use");
    }
  });

  it("returns invalid_grant when refresh token is not found", async () => {
    await setupPrisma({ rt: null });

    const result = await exchangeRefreshToken({
      refreshToken: "nonexistent-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when refresh token is expired", async () => {
    await setupPrisma({
      rt: {
        ...VALID_RT,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const result = await exchangeRefreshToken({
      refreshToken: "expired-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when refresh token is revoked", async () => {
    await setupPrisma({
      rt: {
        ...VALID_RT,
        revokedAt: new Date(Date.now() - 60000),
      },
    });

    const result = await exchangeRefreshToken({
      refreshToken: "revoked-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });

  it("REPLAY DETECTION: rotated token reuse triggers family-wide revocation", async () => {
    const { mockRefreshUpdateMany, mockAccessUpdateMany } = await setupPrisma({
      rt: {
        ...VALID_RT,
        rotatedAt: new Date(Date.now() - 30000), // already rotated = replay
      },
    });

    const result = await exchangeRefreshToken({
      refreshToken: "already-rotated-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");

    // All tokens in the family must be revoked
    expect(mockRefreshUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ familyId: VALID_RT.familyId, revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );

    // Associated access tokens must also be revoked
    expect(mockAccessUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("REPLAY DETECTION: revokes associated access tokens on replay", async () => {
    const { mockRefreshFindMany, mockAccessUpdateMany } = await setupPrisma({
      rt: {
        ...VALID_RT,
        rotatedAt: new Date(Date.now() - 30000),
      },
      refreshFindMany: vi.fn().mockResolvedValue([
        { accessTokenId: "at-1" },
        { accessTokenId: "at-2" },
      ]),
    });

    await exchangeRefreshToken({
      refreshToken: "replayed-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(mockRefreshFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: VALID_RT.familyId },
      }),
    );
    expect(mockAccessUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["at-1", "at-2"] } }),
      }),
    );
  });

  it("returns invalid_client when client_id does not match", async () => {
    await setupPrisma({
      rt: {
        ...VALID_RT,
        mcpClient: { ...VALID_CLIENT, clientId: "mcpc_other" },
      },
    });

    const result = await exchangeRefreshToken({
      refreshToken: "valid-refresh-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("returns invalid_client when client_secret is wrong", async () => {
    await setupPrisma();

    const result = await exchangeRefreshToken({
      refreshToken: "valid-refresh-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:wrong-secret",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("marks the old refresh token as rotated on successful exchange", async () => {
    const { mockRefreshUpdate } = await setupPrisma();

    await exchangeRefreshToken({
      refreshToken: "valid-refresh-token",
      clientId: "mcpc_testclient",
      clientSecretHash: "hashed:correct-secret",
    });

    expect(mockRefreshUpdate).toHaveBeenCalledOnce();
    expect(mockRefreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_RT.id },
        data: expect.objectContaining({
          rotatedAt: expect.any(Date),
          replacedByHash: expect.any(String),
        }),
      }),
    );
  });
});
