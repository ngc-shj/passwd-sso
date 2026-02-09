import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaTag } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTag: {
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { tag: mockPrismaTag },
}));

import { PUT, DELETE } from "./route";

const TAG_ID = "tag-123";

describe("PUT /api/tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "New" } }),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when tag not found", async () => {
    mockPrismaTag.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "New" } }),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when tag belongs to another user", async () => {
    mockPrismaTag.findUnique.mockResolvedValue({ id: TAG_ID, userId: "other-user" });
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "New" } }),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid body", async () => {
    mockPrismaTag.findUnique.mockResolvedValue({ id: TAG_ID, userId: "test-user-id", name: "Old" });
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "" } }),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when new name is duplicate", async () => {
    mockPrismaTag.findUnique
      .mockResolvedValueOnce({ id: TAG_ID, userId: "test-user-id", name: "Old" })
      .mockResolvedValueOnce({ id: "other-tag" }); // duplicate check
    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "Duplicate" } }),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(409);
  });

  it("updates tag successfully", async () => {
    mockPrismaTag.findUnique
      .mockResolvedValueOnce({ id: TAG_ID, userId: "test-user-id", name: "Old" })
      .mockResolvedValueOnce(null); // no duplicate
    mockPrismaTag.update.mockResolvedValue({ id: TAG_ID, name: "New", color: "#ff0000" });

    const res = await PUT(
      createRequest("PUT", "http://localhost:3000/api/tags/tag-123", { body: { name: "New", color: "#ff0000" } }),
      createParams({ id: TAG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ id: TAG_ID, name: "New", color: "#ff0000" });
  });
});

describe("DELETE /api/tags/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/tags/tag-123"),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when tag not found", async () => {
    mockPrismaTag.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/tags/tag-123"),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when tag belongs to another user", async () => {
    mockPrismaTag.findUnique.mockResolvedValue({ id: TAG_ID, userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/tags/tag-123"),
      createParams({ id: TAG_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("deletes tag successfully", async () => {
    mockPrismaTag.findUnique.mockResolvedValue({ id: TAG_ID, userId: "test-user-id" });
    mockPrismaTag.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", "http://localhost:3000/api/tags/tag-123"),
      createParams({ id: TAG_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaTag.delete).toHaveBeenCalledWith({ where: { id: TAG_ID } });
  });
});
