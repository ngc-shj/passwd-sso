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

describe("PUT /api/user/locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.update.mockResolvedValue({ id: "user-1", locale: "en" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: { locale: "en" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = createRequest("PUT", "http://localhost/api/user/locale");
    vi.spyOn(req, "json").mockRejectedValue(new Error("parse error"));
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid locale value", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: { locale: "fr" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for missing locale field", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it("updates locale to en", async () => {
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: { locale: "en" },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.locale).toBe("en");
    expect(mockPrismaUser.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { locale: "en" },
    });
  });

  it("updates locale to ja", async () => {
    mockPrismaUser.update.mockResolvedValue({ id: "user-1", locale: "ja" });
    const res = await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: { locale: "ja" },
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.locale).toBe("ja");
  });

  it("uses withUserTenantRls for tenant isolation", async () => {
    await PUT(
      createRequest("PUT", "http://localhost/api/user/locale", {
        body: { locale: "en" },
      }),
    );
    expect(mockWithUserTenantRls).toHaveBeenCalledWith(
      "user-1",
      expect.any(Function),
    );
  });
});
