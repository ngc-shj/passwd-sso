import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaPasswordEntry } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { passwordEntry: mockPrismaPasswordEntry, auditLog: { create: vi.fn().mockResolvedValue({}) } },
}));

import { POST } from "./route";

const PW_ID = "pw-123";

describe("POST /api/passwords/[id]/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${PW_ID}/restore`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${PW_ID}/restore`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when entry belongs to another user", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      userId: "other-user",
      deletedAt: new Date(),
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${PW_ID}/restore`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when entry is not in trash", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      userId: "test-user-id",
      deletedAt: null,
    });
    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${PW_ID}/restore`),
      createParams({ id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Not in trash");
  });

  it("restores entry from trash successfully", async () => {
    mockPrismaPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      userId: "test-user-id",
      deletedAt: new Date(),
    });
    mockPrismaPasswordEntry.update.mockResolvedValue({});

    const res = await POST(
      createRequest("POST", `http://localhost:3000/api/passwords/${PW_ID}/restore`),
      createParams({ id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaPasswordEntry.update).toHaveBeenCalledWith({
      where: { id: PW_ID },
      data: { deletedAt: null },
    });
  });
});
