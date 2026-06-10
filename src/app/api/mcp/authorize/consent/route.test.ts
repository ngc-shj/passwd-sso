import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockWithBypassRls,
  mockFindFirst,
  mockFindUnique,
  mockCreateAuthorizationCode,
  mockLogAudit,
  mockMcpClientCount,
  mockMcpClientUpdateMany,
  mockMcpClientFindUnique,
  mockTxFindFirst,
  mockTxDelete,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockWithBypassRls: vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p)),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreateAuthorizationCode: vi.fn(),
  mockLogAudit: vi.fn(),
  mockMcpClientCount: vi.fn().mockResolvedValue(0),
  mockMcpClientUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockMcpClientFindUnique: vi.fn(),
  mockTxFindFirst: vi.fn().mockResolvedValue(null),
  mockTxDelete: vi.fn().mockResolvedValue({}),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findFirst: mockFindFirst,
      findUnique: mockMcpClientFindUnique,
      count: mockMcpClientCount,
      updateMany: mockMcpClientUpdateMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: mockFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        mcpClient: {
          count: mockMcpClientCount,
          findFirst: mockTxFindFirst,
          updateMany: mockMcpClientUpdateMany,
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          delete: mockTxDelete,
        },
      }),
    ),
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  createAuthorizationCode: mockCreateAuthorizationCode,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
}));

vi.mock("@/lib/auth/session/step-up", () => ({
  requireRecentSession: mockRequireRecentSession,
}));

import { POST } from "@/app/api/mcp/authorize/consent/route";
import { Prisma } from "@prisma/client";

const VALID_SESSION = { user: { id: "user-uuid-123" } };

const VALID_CLIENT = {
  id: "client-db-uuid",
  clientId: "mcpc_testclient",
  isActive: true,
  tenantId: "tenant-uuid-123",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:list,credentials:use,passwords:read",
};

const VALID_USER = {
  tenantId: "tenant-uuid-123",
};

function buildFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

function createFormRequest(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const fd = buildFormData(fields);
  const urlObj = new URL(url);
  return new Request(url, {
    method: "POST",
    body: fd,
    headers: {
      origin: urlObj.origin,
      host: urlObj.host,
      ...headers,
    },
  });
}

const VALID_FORM_FIELDS = {
  client_id: "mcpc_testclient",
  redirect_uri: "https://example.com/callback",
  scope: "credentials:list credentials:use",
  code_challenge: "test-challenge-value-base64url",
  code_challenge_method: "S256",
  state: "random-state-value",
};

describe("POST /api/mcp/authorize/consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(VALID_SESSION);
    // withBypassRls: always execute callback (may be called 2+ times for claiming)
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockFindUnique.mockResolvedValue(VALID_USER);
    mockTxFindFirst.mockResolvedValue(null); // default: no existing same-name client
    mockTxDelete.mockResolvedValue({});
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientUpdateMany.mockResolvedValue({ count: 1 });
    mockRequireRecentSession.mockResolvedValue(null);
    mockCreateAuthorizationCode.mockResolvedValue({
      code: "auth-code-abc123",
      expiresAt: new Date(Date.now() + 60000),
    });
  });

  it("returns 403 when Origin header is missing (CSRF check)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
      { origin: "" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INVALID_ORIGIN");
  });

  it("returns 302 redirect with code and state on valid consent", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("code")).toBe("auth-code-abc123");
    expect(url.searchParams.get("state")).toBe("random-state-value");
    expect(url.searchParams.has("error")).toBe(false);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when session step-up is required", async () => {
    mockRequireRecentSession.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  it("returns 400 when client_id is missing", async () => {
    const { client_id: _removed, ...fields } = VALID_FORM_FIELDS;
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      fields,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when redirect_uri is missing", async () => {
    const { redirect_uri: _removed, ...fields } = VALID_FORM_FIELDS;
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      fields,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when client is not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
  });

  it("returns 400 when redirect_uri is not in client's registered URIs", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, redirect_uri: "https://evil.example.com/callback" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 403 when client belongs to a different tenant", async () => {
    // Client has a different tenantId than the user
    mockFindFirst.mockResolvedValue({
      ...VALID_CLIENT,
      tenantId: "different-tenant-uuid",
    });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
  });

  it("returns 403 when user has no tenant", async () => {
    mockFindUnique.mockResolvedValue({ tenantId: null });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
  });

  it("returns 302 with error=invalid_scope when no granted scopes overlap", async () => {
    // Request a scope not in client's allowedScopes
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: "admin:delete" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    expect(url.searchParams.get("state")).toBe("random-state-value");
  });

  it("returns 400 when code_challenge_method is not S256", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, code_challenge_method: "plain" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("calls createAuthorizationCode with correct params", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: VALID_CLIENT.id,
        tenantId: VALID_USER.tenantId,
        userId: VALID_SESSION.user.id,
        redirectUri: "https://example.com/callback",
        codeChallenge: "test-challenge-value-base64url",
        scope: expect.stringContaining("credentials:list"),
      }),
    );
  });

  it("calls logAuditAsync after successful consent", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VALID_SESSION.user.id,
        tenantId: VALID_USER.tenantId,
        targetId: VALID_CLIENT.id,
      }),
    );
  });

  it("claims DCR client on Allow and issues authorization code", async () => {
    // mockFindFirst: client lookup → unclaimed DCR client
    // mockTxFindFirst: $transaction existing same-name check → null (no conflict)
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientCount.mockResolvedValueOnce(0);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
  });

  it("redirects with error=access_denied and calls logAuditAsync on deny action", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      {
        action: "deny",
        client_id: "mcpc_testclient",
        redirect_uri: "https://example.com/callback",
        state: "random-state-value",
      },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("random-state-value");

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VALID_SESSION.user.id,
        tenantId: VALID_USER.tenantId,
        targetId: VALID_CLIENT.id,
      }),
    );
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // C7 acceptance tests

  // (a) User B consenting with a name matching user A's DCR client does NOT
  //     delete A's client and gets a consent error.
  it("C7(a): foreign-owned same-name DCR client blocks consent without deleting the owner's client", async () => {
    const userBSession = { user: { id: "user-b-uuid" } };
    mockAuth.mockResolvedValue(userBSession);
    // Unclaimed DCR client registered by nobody yet (tenantId null)
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with createdById = user-b-uuid → null (user B has no own same-name client)
    // tx.findFirst without createdById → foreign-owned client exists
    const foreignClient = { id: "user-a-client-id", createdById: "user-a-uuid" };
    mockTxFindFirst
      .mockResolvedValueOnce(null)         // createdById check: user B owns nothing
      .mockResolvedValueOnce(foreignClient); // foreign-owned check: user A's client

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
    expect(json.error_description).toBe("name_conflict");
    // User A's client must not have been deleted
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockMcpClientUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // (b) User A re-claiming their own DCR client still replaces their own row.
  it("C7(b): user re-claiming own DCR client name replaces the old row and succeeds", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with createdById = session.user.id → user's own existing client
    mockTxFindFirst.mockResolvedValueOnce({ id: "old-client-id", createdById: VALID_SESSION.user.id });
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
    // The old client row must have been deleted
    expect(mockTxDelete).toHaveBeenCalledOnce();
    expect(mockTxDelete).toHaveBeenCalledWith({ where: { id: "old-client-id" } });
  });

  // T2: owner-scoped findFirst must include createdById + shared id:not guard
  it("T2: owner-scoped findFirst where includes createdById and shared id:not guard", async () => {
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    // Assert owner-scoped findFirst was called with createdById + id:not guard
    expect(mockTxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: VALID_SESSION.user.id,
          id: expect.objectContaining({ not: "claim-target-id" }),
        }),
      }),
    );
  });

  // T2 red-green: temporarily removing createdById from the route's where must
  // make the above assertion fail. This test documents the regression-guard.
  // Verification: edit route to remove createdById → T2 test turns red → restore.

  // T2: self-target — claiming when the only same-name own client IS the claim
  // target (id matches) must NOT delete anything (the id:not guard excludes it).
  it("T2: same-target self-claim does not delete the claim target itself", async () => {
    // claimTarget IS the client being claimed (same id)
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with id:{ not: "claim-target-id" } → returns null (no OTHER same-name own client)
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    // No delete must have been called — the claim target itself is excluded
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
  });

  // F6: same-user double-submit — the claim target is already claimed by this user.
  // The foreignOwned lookup must also exclude the claim target (via sameNameWhereBase),
  // so the flow reaches already_claimed recovery, NOT name_conflict.
  it("F6: same-user double-submit reaches already_claimed recovery, not name_conflict", async () => {
    // Unclaimed DCR client (the new registration attempt)
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    // owner-scoped findFirst: no OTHER same-name own client (null — claim target excluded by id:not)
    mockTxFindFirst.mockResolvedValueOnce(null);
    // foreignOwned findFirst: also null — claim target excluded by id:not,
    // and no other same-name row exists
    mockTxFindFirst.mockResolvedValueOnce(null);
    // CAS updateMany returns 0 — already claimed by this user
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 0 });
    // already_claimed refetch: returns this user's already-claimed client
    mockMcpClientFindUnique.mockResolvedValueOnce({
      ...VALID_CLIENT,
      id: "claim-target-id",
      isDcr: true,
      tenantId: VALID_USER.tenantId,
    });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    // Must NOT respond with name_conflict — must reach the already_claimed path
    // and succeed with an authorization code redirect
    const json = res.status !== 302 ? await res.json() : null;
    expect(json?.error_description).not.toBe("name_conflict");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    // No delete of any foreign client
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
  });

  // (c) P2002 unique-violation race maps to consent error (not a 500).
  it("C7(c): P2002 unique violation during claim maps to name_conflict consent error", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    // $transaction throws P2002 (concurrent foreign claim won the race)
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    // Override $transaction to throw P2002
    const { prisma: mockPrismaModule } = await import("@/lib/prisma");
    vi.mocked(mockPrismaModule.$transaction).mockRejectedValueOnce(p2002);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
    expect(json.error_description).toBe("name_conflict");
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });
});
