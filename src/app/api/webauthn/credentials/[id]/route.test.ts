import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockPrismaFindFirst,
  mockPrismaDelete,
  mockPrismaUpdate,
  mockWithUserTenantRls,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaFindFirst: vi.fn(),
  mockPrismaDelete: vi.fn(),
  mockPrismaUpdate: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: {
      findFirst: mockPrismaFindFirst,
      delete: mockPrismaDelete,
      update: mockPrismaUpdate,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));

import { DELETE, PATCH } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/credentials/cred-1";

const EXISTING_CREDENTIAL = {
  id: "cred-1",
  credentialId: "cred-id-abc123",
};

const UPDATED_CREDENTIAL = {
  id: "cred-1",
  nickname: "My YubiKey",
  deviceType: "singleDevice",
  backedUp: false,
  prfSupported: false,
  createdAt: new Date("2024-01-01"),
  lastUsedAt: null,
};

const CTX = createParams({ id: "cred-1" });

// ── DELETE ────────────────────────────────────────────────────

describe("DELETE /api/webauthn/credentials/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindFirst.mockResolvedValue(EXISTING_CREDENTIAL);
    mockPrismaDelete.mockResolvedValue(EXISTING_CREDENTIAL);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when credential does not exist", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when credential belongs to a different user", async () => {
    // The route filters by { id, userId } so a cross-user lookup returns null
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("deletes the credential and returns success", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    const { status, json } = await parseResponse(await DELETE(req, CTX));

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaDelete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cred-1" } }),
    );
  });

  it("queries credential filtered by id and userId", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockPrismaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1", userId: "user-1" },
      }),
    );
  });

  it("calls logAuditAsync with credential metadata", async () => {
    const req = createRequest("DELETE", ROUTE_URL);
    await DELETE(req, CTX);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBAUTHN_CREDENTIAL_DELETE",
        userId: "user-1",
        targetId: "cred-1",
        metadata: { credentialId: "cred-id-abc123" },
      }),
    );
  });
});

// ── PATCH ─────────────────────────────────────────────────────

describe("PATCH /api/webauthn/credentials/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindFirst.mockResolvedValue({ id: "cred-1" });
    mockPrismaUpdate.mockResolvedValue(UPDATED_CREDENTIAL);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My Key" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when credential does not exist", async () => {
    mockPrismaFindFirst.mockResolvedValue(null);

    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My Key" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 when nickname is missing", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: {} });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 400 when nickname exceeds max length", async () => {
    const req = createRequest("PATCH", ROUTE_URL, {
      body: { nickname: "a".repeat(500) },
    });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("updates nickname and returns updated credential", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "My YubiKey" } });
    const { status, json } = await parseResponse(await PATCH(req, CTX));

    expect(status).toBe(200);
    expect(json.nickname).toBe("My YubiKey");
    expect(mockPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1" },
        data: { nickname: "My YubiKey" },
      }),
    );
  });

  it("queries credential filtered by id and userId before updating", async () => {
    const req = createRequest("PATCH", ROUTE_URL, { body: { nickname: "Key" } });
    await PATCH(req, CTX);

    expect(mockPrismaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-1", userId: "user-1" },
      }),
    );
  });
});
