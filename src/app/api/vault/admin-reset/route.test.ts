import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockLogAudit, mockExecuteVaultReset,
  mockAdminVaultResetFindUnique, mockAdminVaultResetUpdate,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogAudit: vi.fn(),
  mockExecuteVaultReset: vi.fn(),
  mockAdminVaultResetFindUnique: vi.fn(),
  mockAdminVaultResetUpdate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminVaultReset: {
      findUnique: mockAdminVaultResetFindUnique,
      update: mockAdminVaultResetUpdate,
    },
  },
}));
vi.mock("@/lib/csrf", () => ({
  assertOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/vault-reset", () => ({
  executeVaultReset: mockExecuteVaultReset,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn((_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from "./route";

const URL = "http://localhost/api/vault/admin-reset";
const TOKEN = "a".repeat(64);

// SHA-256 hash of the token is computed in the route, mock returns based on hash
const RESET_RECORD = {
  id: "reset-1",
  teamId: "team-1",
  targetUserId: "user-1",
  initiatedById: "admin-1",
  tokenHash: "expected-hash",
  expiresAt: new Date(Date.now() + 3600_000),
  executedAt: null,
  revokedAt: null,
};

describe("POST /api/vault/admin-reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_URL = "http://localhost:3000";
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockAdminVaultResetFindUnique.mockResolvedValue(RESET_RECORD);
    mockExecuteVaultReset.mockResolvedValue({ deletedEntries: 3, deletedAttachments: 1 });
    mockAdminVaultResetUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing body", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on wrong confirmation text", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "保管庫を削除" },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VAULT_RESET_CONFIRMATION_MISMATCH");
  });

  it("returns 404 when token not found", async () => {
    mockAdminVaultResetFindUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when token belongs to a different user", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(403);
  });

  it("returns 410 when token is expired", async () => {
    mockAdminVaultResetFindUnique.mockResolvedValue({
      ...RESET_RECORD,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe("VAULT_RESET_TOKEN_EXPIRED");
  });

  it("returns 410 when token is already executed", async () => {
    mockAdminVaultResetFindUnique.mockResolvedValue({
      ...RESET_RECORD,
      executedAt: new Date(),
    });
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe("VAULT_RESET_TOKEN_USED");
  });

  it("returns 410 when token is revoked", async () => {
    mockAdminVaultResetFindUnique.mockResolvedValue({
      ...RESET_RECORD,
      revokedAt: new Date(),
    });
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe("VAULT_RESET_TOKEN_USED");
  });

  it("executes vault reset, marks token, and logs audit on success", async () => {
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "DELETE MY VAULT" },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Vault reset executed
    expect(mockExecuteVaultReset).toHaveBeenCalledWith("user-1");

    // Token marked as executed
    expect(mockAdminVaultResetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "reset-1" },
        data: expect.objectContaining({ executedAt: expect.any(Date) }),
      }),
    );

    // Audit log
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_EXECUTE",
        userId: "user-1",
        teamId: "team-1",
        metadata: expect.objectContaining({
          deletedEntries: 3,
          deletedAttachments: 1,
          initiatedById: "admin-1",
        }),
      }),
    );
  });

  it("confirmation must be English regardless of locale", async () => {
    // Japanese text should fail
    const res = await POST(createRequest("POST", URL, {
      body: { token: TOKEN, confirmation: "保管庫を削除する" },
    }));
    expect(res.status).toBe(400);
  });
});
