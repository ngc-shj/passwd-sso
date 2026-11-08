import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockRequireRecentSession,
  mockMemberFindFirst,
  mockMemberFindMany,
  mockCredentialFindFirst,
  mockCredentialDeleteMany,
  mockRevokeArtifacts,
  mockInvalidateCachedSessions,
  mockLogAuditInTx,
  mockCreateNotification,
  mockSendEmail,
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
    mockCredentialFindFirst: vi.fn(),
    mockCredentialDeleteMany: vi.fn(),
    mockRevokeArtifacts: vi.fn(),
    mockInvalidateCachedSessions: vi.fn(),
    mockLogAuditInTx: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockSendEmail: vi.fn(),
    calls,
    committed: { value: false },
  };
});

const tx = {
  tenantMember: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
  webAuthnCredential: { findFirst: mockCredentialFindFirst, deleteMany: mockCredentialDeleteMany },
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
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  tenantAuditBase: vi.fn((_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId })),
}));
vi.mock("@/lib/notification", () => ({ createNotification: mockCreateNotification }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));

import { DELETE } from "./route";

const ADMIN = "admin-1";
const TARGET = "member-1";
const CRED = "cred-row-1";
const COUNTS = {
  sessions: 2,
  extensionTokens: 1,
  apiKeys: 0,
  mcpAccessTokens: 0,
  mcpRefreshTokens: 0,
  delegationSessions: 0,
  operatorTokens: 0,
};

function revoke() {
  return DELETE(
    createRequest("DELETE", `http://localhost/api/tenant/members/${TARGET}/passkeys/${CRED}`),
    createParams({ userId: TARGET, credentialId: CRED }),
  );
}

describe("DELETE /api/tenant/members/[userId]/passkeys/[credentialId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    committed.value = false;
    mockAuth.mockResolvedValue({ user: { id: ADMIN, name: "Admin", email: "admin@example.com" } });
    mockRequireTenantPermission.mockResolvedValue({ tenantId: "tenant-1", role: "OWNER" });
    mockRequireRecentSession.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue({ role: "MEMBER" });
    mockMemberFindMany.mockResolvedValue([
      { userId: ADMIN, role: "OWNER", user: { email: "admin@example.com", locale: "en" } },
      { userId: TARGET, role: "MEMBER", user: { email: "member@example.com", locale: "ja" } },
    ]);
    mockCredentialFindFirst.mockResolvedValue({ id: CRED, credentialId: "public-cred", tenantId: "tenant-1" });
    mockCredentialDeleteMany.mockImplementation(async () => {
      calls.push("delete");
      return { count: 1 };
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

  it("deletes, revokes the member's sessions and tokens in every tenant and audits in one transaction; evicts the cache after commit", async () => {
    const res = await revoke();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 2, cacheTombstoneFailures: 0 });
    expect(calls).toEqual(["delete", "revoke", "audit", "cache-after-commit"]);
    expect(mockRevokeArtifacts).toHaveBeenCalledWith(tx, TARGET, { tenantFilter: {} });
    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["d1", "d2"]);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      expect.objectContaining({
        action: "TENANT_MEMBER_PASSKEY_REVOKE",
        metadata: { targetUserId: TARGET, credentialId: "public-cred", registeredInTenant: true, ...COUNTS },
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: TARGET, type: "SECURITY_ALERT" }));
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "member@example.com" }));
  });

  it("a failed revocation fails the request: no commit, no cache eviction, the member is not told", async () => {
    mockRevokeArtifacts.mockRejectedValue(new Error("db down"));

    await expect(revoke()).rejects.toThrow("db down");
    expect(committed.value).toBe(false);
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("a cache eviction failure after commit is reported in the response, not hidden", async () => {
    mockInvalidateCachedSessions.mockResolvedValue({ total: 2, failed: 2 });

    const res = await revoke();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cacheTombstoneFailures: 2 });
  });

  it("a step-up refusal is returned before anything is deleted", async () => {
    mockRequireRecentSession.mockResolvedValue(NextResponse.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }));

    expect((await revoke()).status).toBe(403);
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
    expect(mockRevokeArtifacts).not.toHaveBeenCalled();
  });

  it("a role change committed after the pre-check is re-read at the delete: refused, nothing deleted", async () => {
    mockMemberFindMany.mockResolvedValue([
      { userId: ADMIN, role: "ADMIN", user: { email: null, locale: null } },
      { userId: TARGET, role: "ADMIN", user: { email: null, locale: null } },
    ]);

    expect((await revoke()).status).toBe(403);
    expect(mockCredentialDeleteMany).not.toHaveBeenCalled();
  });

  it("a concurrent revoke of the same passkey answers 404, with no revocation or audit", async () => {
    mockCredentialDeleteMany.mockResolvedValueOnce({ count: 0 });

    expect((await revoke()).status).toBe(404);
    expect(mockRevokeArtifacts).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });
});
