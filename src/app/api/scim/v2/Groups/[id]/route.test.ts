import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { roleGroupId } from "@/lib/scim/serializers";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockOrgMember,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockOrgMember: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/scim-token", () => ({
  validateScimToken: mockValidateScimToken,
}));
vi.mock("@/lib/scim/rate-limit", () => ({
  checkScimRateLimit: mockCheckScimRateLimit,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: mockOrgMember,
  },
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", orgId: "org-1", createdById: "u1", auditUserId: "u1" },
};

// Compute a valid ADMIN group ID for org-1
const ADMIN_GROUP_ID = roleGroupId("org-1", "ADMIN");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeReq(options: { method?: string; body?: unknown } = {}) {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  return new NextRequest(
    `http://localhost/api/scim/v2/Groups/${ADMIN_GROUP_ID}`,
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

describe("GET /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 404 for unknown group id", async () => {
    const res = await GET(makeReq(), makeParams("unknown-id"));
    expect(res.status).toBe(404);
  });

  it("returns group with members", async () => {
    mockOrgMember.findMany.mockResolvedValue([
      {
        userId: "user-1",
        role: "ADMIN",
        deactivatedAt: null,
        user: { id: "user-1", email: "admin@example.com" },
      },
    ]);

    const res = await GET(makeReq(), makeParams(ADMIN_GROUP_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("ADMIN");
    expect(body.members).toHaveLength(1);
  });
});

describe("PATCH /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("adds a member to the group", async () => {
    mockOrgMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "MEMBER",
    });
    mockOrgMember.update.mockResolvedValue({});
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: "user-1" }],
            },
          ],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(200);
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { role: "ADMIN" },
      }),
    );
  });

  it("blocks PATCH on OWNER member", async () => {
    mockOrgMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "OWNER",
    });

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: "owner-1" }],
            },
          ],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(403);
  });

  it("removes a member from the group (defaults to MEMBER)", async () => {
    mockOrgMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "ADMIN",
    });
    mockOrgMember.update.mockResolvedValue({});
    mockOrgMember.findMany.mockResolvedValue([]);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "remove",
              path: "members",
              value: [{ value: "user-1" }],
            },
          ],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(200);
    expect(mockOrgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { role: "MEMBER" },
      }),
    );
  });
});

describe("PUT /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("replaces group members", async () => {
    // Current members: user-1 (ADMIN)
    mockOrgMember.findMany
      .mockResolvedValueOnce([{ id: "m1", userId: "user-1", role: "ADMIN" }]) // current members
      .mockResolvedValueOnce([]); // buildGroupResource

    // user-2 will be added
    mockOrgMember.findUnique.mockResolvedValue({ id: "m2", role: "MEMBER" });
    mockOrgMember.update.mockResolvedValue({});

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          members: [{ value: "user-2" }],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(200);
  });

  it("blocks PUT when removing OWNER member", async () => {
    mockOrgMember.findMany.mockResolvedValue([
      { id: "m1", userId: "owner-1", role: "ADMIN" },
    ]);
    // OWNER protection check
    mockOrgMember.findUnique.mockResolvedValue({ role: "OWNER" });

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          members: [],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 405 for DELETE (role-based groups cannot be deleted)", async () => {
    const res = await DELETE(
      makeReq({ method: "DELETE" }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(405);
  });
});
