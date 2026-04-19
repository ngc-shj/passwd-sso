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
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreateAuthorizationCode: vi.fn(),
  mockLogAudit: vi.fn(),
  mockMcpClientCount: vi.fn().mockResolvedValue(0),
  mockMcpClientUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockMcpClientFindUnique: vi.fn(),
  mockTxFindFirst: vi.fn().mockResolvedValue(null),
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
          delete: vi.fn().mockResolvedValue({}),
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

vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
}));

vi.mock("@/lib/csrf", () => ({
  assertOrigin: vi.fn().mockReturnValue(null),
}));

import { POST } from "@/app/api/mcp/authorize/consent/route";

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
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: () => unknown) => fn());
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockFindUnique.mockResolvedValue(VALID_USER);
    mockTxFindFirst.mockResolvedValue(null); // default: no existing same-name client
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientUpdateMany.mockResolvedValue({ count: 1 });
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

  it("returns 403 when Origin header does not match host (CSRF check)", async () => {
    const { assertOrigin } = await import("@/lib/csrf");
    const mockAssertOrigin = vi.mocked(assertOrigin);
    const { NextResponse } = await import("next/server");
    mockAssertOrigin.mockReturnValueOnce(
      NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 }),
    );

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
      { origin: "https://evil.example.com" },
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
});
