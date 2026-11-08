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
    calls,
    committed: { value: false },
  };
});

const tx = {
  tenantMember: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
  webAuthnCredential: { findMany: mockCredentialFindMany, deleteMany: mockCredentialDeleteMany },
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  requireTenantPermission: mockRequireTenantPermission,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
}));
vi.mock("@/lib/tenant-rls", () => ({
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
import { DELETE } from "./route";

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

function revokeAll() {
  return DELETE(
    createRequest("DELETE", `http://localhost/api/tenant/members/${TARGET}/passkeys`),
    createParams({ userId: TARGET }),
  );
}

describe("DELETE /api/tenant/members/[userId]/passkeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    committed.value = false;
    mockAuth.mockResolvedValue({ user: { id: ADMIN, name: "Admin", email: "admin@example.com" } });
    mockRequireTenantPermission.mockResolvedValue({ userId: ADMIN, tenantId: "tenant-1", role: "OWNER" });
    mockRequireRecentSession.mockResolvedValue(null);
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

  it("a member with no passkeys left answers 404, with no revocation or audit", async () => {
    mockCredentialFindMany.mockResolvedValue([]);

    expect((await revokeAll()).status).toBe(404);
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
    expect(mockRevokeArtifacts).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
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
});
