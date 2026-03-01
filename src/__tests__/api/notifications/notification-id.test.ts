import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import {
  createRequest,
  createParams,
  parseResponse,
} from "../../helpers/request-builder";

const {
  mockAuth,
  mockFindUnique,
  mockUpdate,
  mockDelete,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockWithUserTenantRls: vi.fn(
    async (_userId: string, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findUnique: mockFindUnique,
      update: mockUpdate,
      delete: mockDelete,
    },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { PATCH, DELETE } from "@/app/api/notifications/[id]/route";

const EXISTING_NOTIFICATION = {
  id: "notif-1",
  userId: DEFAULT_SESSION.user.id,
  type: "SECURITY_ALERT",
  title: "Test",
  body: "Body",
  isRead: false,
  createdAt: new Date(),
};

describe("PATCH /api/notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "PATCH",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await PATCH(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when notification not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "PATCH",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await PATCH(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when notification belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      ...EXISTING_NOTIFICATION,
      userId: "other-user-id",
    });

    const req = createRequest(
      "PATCH",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await PATCH(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("marks notification as read", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(EXISTING_NOTIFICATION);
    mockUpdate.mockResolvedValue({
      ...EXISTING_NOTIFICATION,
      isRead: true,
    });

    const req = createRequest(
      "PATCH",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await PATCH(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("notif-1");
    expect(json.isRead).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "notif-1" },
      data: { isRead: true },
    });
  });
});

describe("DELETE /api/notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await DELETE(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 404 when notification not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(null);

    const req = createRequest(
      "DELETE",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await DELETE(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 403 when notification belongs to another user", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue({
      ...EXISTING_NOTIFICATION,
      userId: "other-user-id",
    });

    const req = createRequest(
      "DELETE",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await DELETE(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("deletes notification successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFindUnique.mockResolvedValue(EXISTING_NOTIFICATION);
    mockDelete.mockResolvedValue(EXISTING_NOTIFICATION);

    const req = createRequest(
      "DELETE",
      "http://localhost/api/notifications/notif-1",
    );
    const res = await DELETE(req, createParams({ id: "notif-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "notif-1" } });
  });
});
