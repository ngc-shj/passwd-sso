import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaUser, mockWithUserTenantRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { update: vi.fn() },
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

import { PUT } from "./route";

describe("PUT /api/user/favicon-pref", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.update.mockResolvedValue({ id: "user-1", fetchFavicons: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: true },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = createRequest("PUT", "http://localhost/api/user/favicon-pref");
    vi.spyOn(req, "json").mockRejectedValue(new Error("parse error"));
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for unknown field — .strict() rejects extra keys", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: true, x: 1 },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for missing fetchFavicons field", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: {},
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when fetchFavicons is not a boolean", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: "true" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("enables favicons — returns 200 with fetchFavicons:true", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: true },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.fetchFavicons).toBe(true);
    expect(mockPrismaUser.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { fetchFavicons: true },
    });
  });

  it("disables favicons — returns 200 with fetchFavicons:false", async () => {
    mockPrismaUser.update.mockResolvedValue({ id: "user-1", fetchFavicons: false });
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: false },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.fetchFavicons).toBe(false);
  });

  it("uses withUserTenantRls for tenant isolation", async () => {
    await PUT(
      createRequest("PUT", "http://localhost/api/user/favicon-pref", {
        body: { fetchFavicons: true },
      }),
    );
    expect(mockWithUserTenantRls).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
    );
  });
});
