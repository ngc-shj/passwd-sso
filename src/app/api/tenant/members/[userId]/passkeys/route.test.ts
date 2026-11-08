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
  tenantAuditBase: vi.fn((_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: mockSentryCapture }));

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
    mockMemberFindMany.mockResolvedValue([
      { userId: ADMIN, role: "OWNER", user: { email: "admin@example.com", locale: "en" } },
      { userId: TARGET, role: "MEMBER", user: { email: "member@example.com", locale: "ja" } },
    ]);
    mockCredentialFindMany.mockResolvedValue(PASSKEYS);
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
    expect(calls).toEqual(["lock", "delete", "revoke", "audit", "cache-after-commit"]);
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
        metadata: { targetUserId: TARGET, passkeys: 2, credentialIds: ["public-1", "public-2"], ...COUNTS },
      }),
    );
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
