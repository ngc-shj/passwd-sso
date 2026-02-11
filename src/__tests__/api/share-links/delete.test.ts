import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { findUnique: mockFindUnique, update: mockUpdate },
    orgPasswordEntry: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { DELETE } from "@/app/api/share-links/[id]/route";

describe("DELETE /api/share-links/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when share not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when share belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      createdById: "other-user",
      revokedAt: null,
      orgPasswordEntryId: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 409 when already revoked", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: new Date(),
      orgPasswordEntryId: null,
    });

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(409);
    expect(json.error).toBe("ALREADY_REVOKED");
  });

  it("revokes successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      id: "s1",
      createdById: DEFAULT_SESSION.user.id,
      revokedAt: null,
      orgPasswordEntryId: null,
    });
    mockUpdate.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/share-links/s1");
    const res = await DELETE(req as never, createParams({ id: "s1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
