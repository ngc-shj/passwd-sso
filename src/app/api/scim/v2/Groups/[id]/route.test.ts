import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { roleGroupId } from "@/lib/scim/serializers";

const {
  mockValidateScimToken,
  mockCheckScimRateLimit,
  mockLogAudit,
  mockTeamMember,
  mockScimExternalMapping,
  mockTransaction,
} = vi.hoisted(() => ({
  mockValidateScimToken: vi.fn(),
  mockCheckScimRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
  mockTeamMember: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  mockScimExternalMapping: { findFirst: vi.fn() },
  mockTransaction: vi.fn(),
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
    orgMember: mockTeamMember,
    scimExternalMapping: mockScimExternalMapping,
    $transaction: mockTransaction,
  },
}));

import { GET, PUT, PATCH, DELETE } from "./route";

const SCIM_TOKEN_DATA = {
  ok: true as const,
  data: { tokenId: "t1", teamId: "team-1", orgId: "team-1", tenantId: "tenant-1", createdById: "u1", auditUserId: "u1" },
};

// Compute a valid ADMIN group ID for team-1
const ADMIN_GROUP_ID = roleGroupId("team-1", "ADMIN");

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
    vi.resetAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
  });

  it("returns 404 for unknown group id", async () => {
    const res = await GET(makeReq(), makeParams("unknown-id"));
    expect(res.status).toBe(404);
  });

  it("returns group with members", async () => {
    mockTeamMember.findMany.mockResolvedValue([
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

  it("returns 429 when rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await GET(makeReq(), makeParams(ADMIN_GROUP_ID));
    expect(res.status).toBe(429);
  });
});

describe("PATCH /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    // Transaction executes callback with same mock objects
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ orgMember: mockTeamMember }),
    );
  });

  it("adds a member to the group", async () => {
    mockTeamMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "MEMBER",
    });
    mockTeamMember.update.mockResolvedValue({});
    mockTeamMember.findMany.mockResolvedValue([]);

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
    expect(mockTeamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { role: "ADMIN" },
      }),
    );
  });

  it("blocks PATCH on OWNER member", async () => {
    mockTeamMember.findUnique.mockResolvedValue({
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
    mockTeamMember.findUnique.mockResolvedValue({
      id: "m1",
      role: "ADMIN",
    });
    mockTeamMember.update.mockResolvedValue({});
    mockTeamMember.findMany.mockResolvedValue([]);

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
    expect(mockTeamMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { role: "MEMBER" },
      }),
    );
  });

  it("returns 400 for non-existent member", async () => {
    mockTeamMember.findUnique.mockResolvedValue(null);

    const res = await PATCH(
      makeReq({
        method: "PATCH",
        body: {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: "no-such-user" }],
            },
          ],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Referenced member does not exist");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(
      `http://localhost/api/scim/v2/Groups/${ADMIN_GROUP_ID}`,
      { method: "PATCH", body: "not-json", headers: { "content-type": "application/json" } },
    );
    const res = await PATCH(req, makeParams(ADMIN_GROUP_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Invalid JSON");
  });

  it("handles multiple operations in a single PATCH", async () => {
    mockTeamMember.findUnique
      .mockResolvedValueOnce({ id: "m1", role: "MEMBER" })   // user-1
      .mockResolvedValueOnce({ id: "m2", role: "ADMIN" });    // user-2
    mockTeamMember.update.mockResolvedValue({});
    mockTeamMember.findMany.mockResolvedValue([]);

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
            {
              op: "remove",
              path: "members",
              value: [{ value: "user-2" }],
            },
          ],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(200);
    expect(mockTeamMember.update).toHaveBeenCalledTimes(2);
  });
});

describe("PUT /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockValidateScimToken.mockResolvedValue(SCIM_TOKEN_DATA);
    mockCheckScimRateLimit.mockResolvedValue(true);
    // Transaction executes callback with same mock objects
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ orgMember: mockTeamMember }),
    );
  });

  it("replaces group members", async () => {
    // Current members: user-1 (ADMIN)
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "m1", userId: "user-1", role: "ADMIN" }]) // current members
      .mockResolvedValueOnce([]); // buildGroupResource

    // user-2 will be added; OWNER check for user-1 removal returns non-OWNER
    mockTeamMember.findUnique.mockResolvedValue({ id: "m2", role: "MEMBER" });
    mockTeamMember.update.mockResolvedValue({});

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
    mockTeamMember.findMany.mockResolvedValue([
      { id: "m1", userId: "owner-1", role: "ADMIN" },
    ]);
    // OWNER protection check
    mockTeamMember.findUnique.mockResolvedValue({ role: "OWNER" });

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

  it("returns 400 when adding non-existent member", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([]) // current members (none)
      .mockResolvedValueOnce([]); // buildGroupResource

    // Inside tx: member not found
    mockTeamMember.findUnique.mockResolvedValue(null);

    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          members: [{ value: "no-such-user" }],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Referenced member does not exist");
  });

  it("returns 404 for unknown group id", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "ADMIN",
          members: [],
        },
      }),
      makeParams("unknown-group-id"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(
      `http://localhost/api/scim/v2/Groups/${ADMIN_GROUP_ID}`,
      { method: "PUT", body: "not-json", headers: { "content-type": "application/json" } },
    );
    const res = await PUT(req, makeParams(ADMIN_GROUP_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("Invalid JSON");
  });

  it("returns 400 for Zod validation failure (missing schemas)", async () => {
    const res = await PUT(
      makeReq({
        method: "PUT",
        body: {
          displayName: "ADMIN",
          members: [],
        },
      }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(400);
  });

  it("skips demotion when member's role was changed concurrently", async () => {
    mockTeamMember.findMany
      .mockResolvedValueOnce([{ id: "m1", userId: "user-1", role: "ADMIN" }])
      .mockResolvedValueOnce([]); // buildGroupResource
    // tx re-check: role changed to VIEWER concurrently
    mockTeamMember.findUnique.mockResolvedValue({ role: "VIEWER" });
    mockTeamMember.update.mockResolvedValue({});

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
    expect(res.status).toBe(200);
    // Member's role is VIEWER (not ADMIN), so no demotion should occur
    expect(mockTeamMember.update).not.toHaveBeenCalled();
  });

  it("resolves group via ScimExternalMapping fallback", async () => {
    mockScimExternalMapping.findFirst.mockResolvedValue({
      internalId: ADMIN_GROUP_ID,
    });
    mockTeamMember.findMany.mockResolvedValue([]);

    const res = await GET(makeReq(), makeParams("ext-group-id-from-idp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("ADMIN");
  });
});

describe("DELETE /api/scim/v2/Groups/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it("returns 429 when rate limited", async () => {
    mockCheckScimRateLimit.mockResolvedValue(false);
    const res = await DELETE(
      makeReq({ method: "DELETE" }),
      makeParams(ADMIN_GROUP_ID),
    );
    expect(res.status).toBe(429);
  });
});
