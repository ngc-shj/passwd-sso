import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockRequireRecentSession,
  mockMemberFindFirst,
  mockMemberFindMany,
  mockCredentialFindMany,
  mockCredentialDeleteMany,
  mockRevokeArtifacts,
  mockInvalidateCachedSessions,
  mockLogAuditInTx,
  mockCreateNotification,
  mockSendEmail,
  mockSentryCapture,
  mockHasTenantPermission,
  calls,
  committed,
} = vi.hoisted(() => {
  // The order the route's steps ran in, by name; `committed` is set when the
  // transaction callback returns without throwing.
  const calls: string[] = [];
  return {
    mockAuth: vi.fn(),
    mockRequireTenantPermission: vi.fn(),
    mockRequireRecentSession: vi.fn(),
    mockMemberFindFirst: vi.fn(),
    mockMemberFindMany: vi.fn(),
    mockCredentialFindMany: vi.fn(),
    mockCredentialDeleteMany: vi.fn(),
    mockRevokeArtifacts: vi.fn(),
    mockInvalidateCachedSessions: vi.fn(),
    mockLogAuditInTx: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    mockSentryCapture: vi.fn(),
    mockHasTenantPermission: vi.fn(),
    calls,
    committed: { value: false },
  };
});

// A containment model: every named id is the member's and live (findMany
// returns one row per id), and each compare-and-set write lands. Each call is
// recorded by model, for the write order.
function containmentModel(name: string, row: Record<string, unknown> = {}) {
  const write = vi.fn(async () => {
    calls.push(name);
    return { count: 1 };
  });
  return {
    findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
      (args.where.id?.in ?? []).map((id) => ({ id, tenantId: "tenant-1", ...row })),
    ),
    updateMany: write,
    deleteMany: write,
  };
}

const tx = {
  tenantMember: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
  webAuthnCredential: { findMany: mockCredentialFindMany, deleteMany: mockCredentialDeleteMany },
  account: containmentModel("account"),
  scimToken: containmentModel("scimToken"),
  serviceAccount: containmentModel("serviceAccount"),
  serviceAccountToken: containmentModel("serviceAccountToken", { serviceAccountId: "sa-1" }),
  mcpClient: containmentModel("mcpClient"),
  mcpAccessToken: containmentModel("mcpAccessToken"),
  mcpRefreshToken: containmentModel("mcpRefreshToken"),
  personalLogAccessGrant: containmentModel("personalLogAccessGrant", { targetUserId: "someone" }),
  emergencyAccessGrant: containmentModel("emergencyAccessGrant", { granteeId: "grantee-1" }),
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
  hasTenantPermission: mockHasTenantPermission,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/tenant-rls", () => ({
  isBypassRlsActive: () => true,
  withTenantRls: (_p: unknown, _t: unknown, fn: (t: typeof tx) => unknown) => fn(tx),
  withBypassRls: async (_p: unknown, fn: (t: typeof tx) => unknown) => {
    const result = await fn(tx);
    committed.value = true;
    return result;
  },
}));
vi.mock("@/lib/auth/session/user-session-invalidation", () => ({
  revokeUserAuthArtifactsInTx: mockRevokeArtifacts,
}));
vi.mock("@/lib/auth/session/user-auth-serialization", () => ({
  lockUserAuthArtifacts: vi.fn(async () => {
    calls.push("lock");
  }),
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  // The admin's request metadata is present, so the other-tenant row's lack of
  // it is the code's doing.
  tenantAuditBase: vi.fn((_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "203.0.113.9",
    userAgent: "admin-ua",
  })),
}));
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: mockSentryCapture }));

import { AUDIT_CREDENTIAL_ID_MAX_LENGTH, METADATA_MAX_BYTES } from "@/lib/validations/common.server";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { DELETE, GET } from "./route";

const ADMIN = "admin-1";
const TARGET = "member-1";
const COUNTS = {
  sessions: 2,
  extensionTokens: 1,
  apiKeys: 0,
  mcpAccessTokens: 0,
  mcpRefreshTokens: 0,
  delegationSessions: 0,
  operatorTokens: 0,
};
const PASSKEYS = [
  { id: "cred-row-1", credentialId: "public-1", tenantId: "tenant-1" },
  { id: "cred-row-2", credentialId: "public-2", tenantId: "previous-tenant" },
];

function revokeAll(body?: unknown) {
  return DELETE(
    createRequest("DELETE", `http://localhost/api/tenant/members/${TARGET}/passkeys`, { body }),
    createParams({ userId: TARGET }),
  );
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("DELETE /api/tenant/members/[userId]/passkeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    committed.value = false;
    mockAuth.mockResolvedValue({ user: { id: ADMIN, name: "Admin", email: "admin@example.com" } });
    mockRequireTenantPermission.mockResolvedValue({ userId: ADMIN, tenantId: "tenant-1", role: "OWNER" });
    mockRequireRecentSession.mockResolvedValue(null);
    mockHasTenantPermission.mockReturnValue(true);
    mockMemberFindFirst.mockResolvedValue({ role: "MEMBER" });
    mockMemberFindMany.mockImplementation(async () => {
      calls.push("roles");
      return [
        { userId: ADMIN, role: "OWNER", user: { email: "admin@example.com", locale: "en" } },
        { userId: TARGET, role: "MEMBER", user: { email: "member@example.com", locale: "ja" } },
      ];
    });
    mockCredentialFindMany.mockImplementation(async () => {
      calls.push("credentials");
      return PASSKEYS;
    });
    mockCredentialDeleteMany.mockImplementation(async () => {
      calls.push("delete");
      return { count: 2 };
    });
    mockRevokeArtifacts.mockImplementation(async () => {
      calls.push("revoke");
      return { counts: COUNTS, sessionTokens: ["d1", "d2"] };
    });
    mockLogAuditInTx.mockImplementation(async () => {
      calls.push("audit");
    });
    mockInvalidateCachedSessions.mockImplementation(async () => {
      calls.push(committed.value ? "cache-after-commit" : "cache-before-commit");
      return { total: 2, failed: 0 };
    });
  });

  it("deletes every passkey of the member, revokes their sessions and tokens in every tenant and audits, in one transaction under the member's lock", async () => {
    const res = await revokeAll();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 2, cacheTombstoneFailures: 0 });
    // Everything is read under the member's lock, the roles re-read first.
    expect(calls).toEqual(["lock", "roles", "credentials", "delete", "revoke", "audit", "audit", "cache-after-commit"]);
    // Every passkey the member has, in any tenant: no id filter on the read.
    expect(mockCredentialFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: TARGET } }));
    expect(mockCredentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: TARGET, id: { in: ["cred-row-1", "cred-row-2"] } },
    });
    expect(mockRevokeArtifacts).toHaveBeenCalledWith(tx, TARGET, { tenantFilter: {} });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      expect.objectContaining({
        action: "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
        targetType: "User",
        targetId: TARGET,
        metadata: { targetUserId: TARGET, passkeys: 2, credentialIds: ["public-1", "public-2"], credentialIdsOmitted: 0, ...COUNTS },
      }),
    );
  });

  it("also audits in each other tenant a revoked passkey was registered under: that tenant's passkeys only, as the system", async () => {
    await revokeAll();

    expect(mockLogAuditInTx).toHaveBeenCalledTimes(2);
    expect(mockLogAuditInTx.mock.calls[1][1]).toBe("previous-tenant");
    expect(mockLogAuditInTx.mock.calls[1][2]).toEqual({
      scope: "TENANT",
      userId: SYSTEM_ACTOR_ID,
      actorType: "SYSTEM",
      tenantId: "previous-tenant",
      ip: null,
      userAgent: null,
      action: "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
      targetType: "User",
      targetId: TARGET,
      metadata: {
        targetUserId: TARGET,
        passkeys: 1,
        credentialIds: ["public-2"],
        credentialIdsOmitted: 0,
        revokedFromTenantId: "tenant-1",
      },
    });
    // The originating tenant's row carries no such marker, and does carry the admin's request.
    expect(mockLogAuditInTx.mock.calls[0][2].metadata.revokedFromTenantId).toBeUndefined();
    expect(mockLogAuditInTx.mock.calls[0][2]).toMatchObject({ userId: ADMIN, ip: "203.0.113.9", userAgent: "admin-ua" });
  });

  it("writes one row per other tenant, however many of its passkeys were revoked", async () => {
    mockCredentialFindMany.mockResolvedValue([
      PASSKEYS[0],
      { id: "cred-row-2", credentialId: "public-2", tenantId: "previous-tenant" },
      { id: "cred-row-3", credentialId: "public-3", tenantId: "previous-tenant" },
      { id: "cred-row-4", credentialId: "public-4", tenantId: "third-tenant" },
    ]);
    mockCredentialDeleteMany.mockResolvedValue({ count: 4 });

    await revokeAll();
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(3);
    const byTenant = Object.fromEntries(mockLogAuditInTx.mock.calls.map((c) => [c[1], c[2].metadata]));
    expect(Object.keys(byTenant).sort()).toEqual(["previous-tenant", "tenant-1", "third-tenant"]);
    expect(byTenant["previous-tenant"]).toMatchObject({ passkeys: 2, credentialIds: ["public-2", "public-3"] });
    expect(byTenant["third-tenant"]).toMatchObject({ passkeys: 1, credentialIds: ["public-4"] });
    expect(byTenant["tenant-1"]).toMatchObject({ passkeys: 4 });
  });

  it("writes no second audit row when every revoked passkey was registered in the admin's tenant", async () => {
    mockCredentialFindMany.mockResolvedValue([PASSKEYS[0], { ...PASSKEYS[1], tenantId: "tenant-1" }]);

    await revokeAll();
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
  });

  it("bounds the audit row's credential ids, so the counts survive the metadata size cap", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `cred-row-${i}`,
      credentialId: `${i}`.padEnd(1023, "x"),
      tenantId: "tenant-1",
    }));
    mockCredentialFindMany.mockResolvedValue(many);
    mockCredentialDeleteMany.mockResolvedValue({ count: 11 });

    await revokeAll();
    const { metadata } = mockLogAuditInTx.mock.calls[0][2];
    expect(metadata.credentialIds).toHaveLength(10);
    expect(metadata.credentialIds.every((id: string) => id.length === AUDIT_CREDENTIAL_ID_MAX_LENGTH)).toBe(true);
    expect(metadata).toMatchObject({ targetUserId: TARGET, passkeys: 11, credentialIdsOmitted: 1, ...COUNTS });
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(METADATA_MAX_BYTES);
  });

  it("answers 401 without a session", async () => {
    mockAuth.mockResolvedValue(null);

    expect((await revokeAll()).status).toBe(401);
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses an actor without MEMBER_MANAGE before anything else", async () => {
    mockRequireTenantPermission.mockRejectedValue(Object.assign(new Error("FORBIDDEN"), { name: "TenantAuthError", status: 403 }));

    expect((await revokeAll()).status).toBe(403);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
  });

  it("tells the member that all their passkeys were revoked", async () => {
    await revokeAll();

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET, type: "SECURITY_ALERT", title: "パスキーがすべて失効されました" }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "member@example.com", subject: "パスキーがすべて失効されました" }),
    );
  });

  it("a member with no passkeys is still contained: sessions and tokens revoked, audited with passkeys 0, told only that their sessions ended", async () => {
    mockCredentialFindMany.mockResolvedValue([]);

    const res = await revokeAll();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 2, cacheTombstoneFailures: 0 });
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
    expect(mockRevokeArtifacts).toHaveBeenCalledWith(tx, TARGET, { tenantFilter: {} });
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx.mock.calls[0][2]).toMatchObject({
      action: "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
      metadata: { targetUserId: TARGET, passkeys: 0, credentialIds: [], credentialIdsOmitted: 0, ...COUNTS },
    });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "すべてのセッションが終了されました" }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: "すべてのセッションが終了されました" }));
  });

  it("refuses the actor's own passkeys before anything else", async () => {
    mockAuth.mockResolvedValue({ user: { id: TARGET } });
    mockRequireTenantPermission.mockResolvedValue({ userId: TARGET, tenantId: "tenant-1", role: "OWNER" });

    expect((await revokeAll()).status).toBe(403);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses a target the actor's role may not touch before asking for a step-up", async () => {
    mockRequireTenantPermission.mockResolvedValue({ userId: ADMIN, tenantId: "tenant-1", role: "ADMIN" });
    mockMemberFindFirst.mockResolvedValue({ role: "OWNER" });

    expect((await revokeAll()).status).toBe(403);
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
  });

  it("a step-up refusal is returned before anything is deleted", async () => {
    mockRequireRecentSession.mockResolvedValue(NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));

    expect((await revokeAll()).status).toBe(403);
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
    expect(mockRevokeArtifacts).not.toHaveBeenCalled();
  });

  it("a failed revocation fails the request: no commit, the member is not told", async () => {
    mockRevokeArtifacts.mockRejectedValue(new Error("db down"));

    await expect(revokeAll()).rejects.toThrow("db down");
    expect(committed.value).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  describe("containment body", () => {
    const ALL_KINDS = {
      unlinkAccountIds: [uuid(1)],
      revoke: {
        scimTokenIds: [uuid(2)],
        serviceAccountIds: [uuid(3)],
        serviceAccountTokenIds: [uuid(4)],
        mcpClientIds: [uuid(5)],
        breakglassGrantIds: [uuid(6)],
        emergencyAccessGrantIds: [uuid(7)],
      },
    };
    const CONTAINMENT_MODELS = [
      "account", "scimToken", "serviceAccount", "serviceAccountToken", "mcpClient",
      "mcpAccessToken", "mcpRefreshToken", "personalLogAccessGrant", "emergencyAccessGrant",
    ] as const;

    it.each([
      ["no body", undefined],
      ["an empty object", {}],
      ["empty arrays", { unlinkAccountIds: [], revoke: { scimTokenIds: [] } }],
    ])("%s contains nothing more: no containment model is touched, no `contained` in the response", async (_label, body) => {
      const res = await revokeAll(body);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 2, cacheTombstoneFailures: 0 });
      for (const model of CONTAINMENT_MODELS) {
        expect(tx[model].findMany).not.toHaveBeenCalled();
        expect(tx[model].updateMany).not.toHaveBeenCalled();
      }
    });

    it("a zero-byte body is no body", async () => {
      const res = await DELETE(
        new (await import("next/server")).NextRequest(`http://localhost/api/tenant/members/${TARGET}/passkeys`, {
          method: "DELETE",
          body: "",
        }),
        createParams({ userId: TARGET }),
      );
      expect(res.status).toBe(200);
    });

    it.each([
      ["101 ids of one kind", { revoke: { scimTokenIds: Array.from({ length: 101 }, (_, i) => uuid(i)) } }],
      ["a non-uuid id", { unlinkAccountIds: ["not-a-uuid"] }],
      ["an unknown top-level key", { unlinkAccountIds: [], revokeAll: true }],
      ["an unknown kind", { revoke: { webhookIds: [uuid(1)] } }],
      ["a non-object", ["x"]],
    ])("refuses %s with 400 before the step-up, and revokes nothing", async (_label, body) => {
      const res = await revokeAll(body);

      expect(res.status).toBe(400);
      expect(mockRequireRecentSession).not.toHaveBeenCalled();
      expect(mockRevokeArtifacts).not.toHaveBeenCalled();
    });

    it("refuses malformed JSON with 400 before the step-up", async () => {
      const res = await DELETE(
        new (await import("next/server")).NextRequest(`http://localhost/api/tenant/members/${TARGET}/passkeys`, {
          method: "DELETE",
          body: "{not json",
        }),
        createParams({ userId: TARGET }),
      );
      expect(res.status).toBe(400);
      expect(mockRequireRecentSession).not.toHaveBeenCalled();
    });

    it("writes every kind after the passkey and session revocation, in the pinned order, before the revoke-all row, in one transaction", async () => {
      const res = await revokeAll(ALL_KINDS);

      expect(res.status).toBe(200);
      const body = await res.json();
      const one = { revoked: 1, skipped: 0 };
      expect(body).toEqual({
        ok: true,
        sessionsRevoked: 2,
        cacheTombstoneFailures: 0,
        contained: {
          accounts: one,
          scimTokens: one,
          serviceAccounts: one,
          serviceAccountTokens: one,
          mcpClients: one,
          breakglassGrants: one,
          emergencyAccessGrants: one,
        },
      });
      const writes = calls.filter((c) => !["lock", "roles", "credentials", "cache-after-commit"].includes(c));
      expect(writes.filter((c) => c !== "audit")).toEqual([
        "delete", "revoke",
        "account",
        "scimToken",
        "serviceAccount", "serviceAccountToken",
        "serviceAccountToken",
        "mcpClient", "mcpAccessToken", "mcpRefreshToken",
        "personalLogAccessGrant",
        "emergencyAccessGrant",
      ]);
      // The revoke-all row comes after every containment write, carrying the counts.
      const revokeAllCall = mockLogAuditInTx.mock.calls.find((c) => c[2].action === "TENANT_MEMBER_PASSKEY_REVOKE_ALL" && c[1] === "tenant-1");
      expect(revokeAllCall?.[2].metadata).toMatchObject({
        accountsContained: 1,
        accountsSkipped: 0,
        scimTokensContained: 1,
        emergencyAccessGrantsContained: 1,
        unlinkedAccountIds: [uuid(1)],
        unlinkedAccountIdsOmitted: 0,
      });
      expect(writes.lastIndexOf("emergencyAccessGrant")).toBeLessThan(writes.lastIndexOf("audit"));
      expect(mockLogAuditInTx.mock.calls.map((c) => c[2].action)).toEqual([
        "SCIM_TOKEN_REVOKE",
        "SERVICE_ACCOUNT_UPDATE",
        "SERVICE_ACCOUNT_TOKEN_REVOKE",
        "MCP_CLIENT_UPDATE",
        "PERSONAL_LOG_ACCESS_REVOKE",
        "EMERGENCY_ACCESS_REVOKE",
        "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
        "TENANT_MEMBER_PASSKEY_REVOKE_ALL",
      ]);
      expect(committed.value).toBe(true);
    });

    it("a containment write that fails fails the request: no commit, the member is not told", async () => {
      tx.emergencyAccessGrant.updateMany.mockRejectedValueOnce(new Error("constraint"));

      await expect(revokeAll(ALL_KINDS)).rejects.toThrow("constraint");
      expect(committed.value).toBe(false);
      expect(mockCreateNotification).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("counts a named id that matches nothing live of the member's as skipped, and audits nothing for it", async () => {
      tx.scimToken.findMany.mockResolvedValueOnce([]);

      const res = await revokeAll({ revoke: { scimTokenIds: [uuid(2)] } });
      expect((await res.json()).contained).toEqual({ scimTokens: { revoked: 0, skipped: 1 } });
      expect(mockLogAuditInTx.mock.calls.map((c) => c[2].action)).not.toContain("SCIM_TOKEN_REVOKE");
    });

    // Per-kind permission is defence in depth (OWNER and ADMIN hold all of them
    // today), so it is driven by the mocked lookup; each refusal has its allow pair.
    it.each([
      ["scimTokenIds", "tenant:scim:manage"],
      ["serviceAccountIds", "tenant:serviceAccount:manage"],
      ["serviceAccountTokenIds", "tenant:serviceAccount:manage"],
      ["mcpClientIds", "tenant:serviceAccount:manage"],
      ["breakglassGrantIds", "tenant:breakglass:request"],
    ])("%s: refused 403 before the step-up without %s, allowed with it", async (key, permission) => {
      mockHasTenantPermission.mockImplementation((_role: string, p: string) => p !== permission);
      const refused = await revokeAll({ revoke: { [key]: [uuid(9)] } });
      expect(refused.status).toBe(403);
      expect(mockRequireRecentSession).not.toHaveBeenCalled();
      expect(mockRevokeArtifacts).not.toHaveBeenCalled();

      mockHasTenantPermission.mockReturnValue(true);
      const allowed = await revokeAll({ revoke: { [key]: [uuid(9)] } });
      expect(allowed.status).toBe(200);
      expect(mockRevokeArtifacts).toHaveBeenCalledTimes(1);
    });

    it("refuses break-glass grants to an ADMIN actor (only an OWNER), allows other kinds", async () => {
      mockRequireTenantPermission.mockResolvedValue({ userId: ADMIN, tenantId: "tenant-1", role: "ADMIN" });

      expect((await revokeAll({ revoke: { breakglassGrantIds: [uuid(6)] } })).status).toBe(403);
      expect(mockRequireRecentSession).not.toHaveBeenCalled();
      expect((await revokeAll({ revoke: { scimTokenIds: [uuid(2)] } })).status).toBe(200);
    });

    it("re-checks the kinds on the role re-read in the transaction: a demotion committed meanwhile refuses", async () => {
      mockMemberFindMany.mockResolvedValue([
        { userId: ADMIN, role: "ADMIN", user: { email: "admin@example.com", locale: "en" } },
        { userId: TARGET, role: "MEMBER", user: { email: "member@example.com", locale: "ja" } },
      ]);

      expect((await revokeAll({ revoke: { breakglassGrantIds: [uuid(6)] } })).status).toBe(403);
      expect(mockRevokeArtifacts).not.toHaveBeenCalled();
    });
  });

  describe("GET lists the footholds each kind's permission allows", () => {
    function list() {
      return GET(
        createRequest("GET", `http://localhost/api/tenant/members/${TARGET}/passkeys`),
        createParams({ userId: TARGET }),
      );
    }

    it.each([
      ["scimTokens", "tenant:scim:manage"],
      ["serviceAccounts", "tenant:serviceAccount:manage"],
      ["serviceAccountTokens", "tenant:serviceAccount:manage"],
      ["mcpClients", "tenant:serviceAccount:manage"],
      ["breakglassGrants", "tenant:breakglass:request"],
    ])("omits %s without %s, lists it with it", async (kind, permission) => {
      mockHasTenantPermission.mockImplementation((_role: string, p: string) => p !== permission);
      const without = await (await list()).json();
      expect(without.createdFootholds).not.toHaveProperty(kind);
      expect(without.createdFootholds).toHaveProperty("emergencyAccessGrants");

      mockHasTenantPermission.mockReturnValue(true);
      const withIt = await (await list()).json();
      expect(withIt.createdFootholds).toHaveProperty(kind);
    });

    it("omits break-glass grants for an ADMIN actor", async () => {
      mockRequireTenantPermission.mockResolvedValue({ userId: ADMIN, tenantId: "tenant-1", role: "ADMIN" });
      const body = await (await list()).json();
      expect(body.createdFootholds).not.toHaveProperty("breakglassGrants");
      expect(body.createdFootholds).toHaveProperty("scimTokens");
    });
  });
});
