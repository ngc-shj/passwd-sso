import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockWithBypassRls,
  mockFindFirst,
  mockFindUnique,
  mockCreateAuthorizationCode,
  mockLogAudit,
  mockExtractRequestMeta,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, fn: () => unknown) => fn()),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreateAuthorizationCode: vi.fn(),
  mockLogAudit: vi.fn(),
  mockExtractRequestMeta: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "test-agent" }),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: { findFirst: mockFindFirst },
    user: { findUnique: mockFindUnique },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  createAuthorizationCode: mockCreateAuthorizationCode,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: mockExtractRequestMeta,
}));

import { POST } from "@/app/api/mcp/authorize/consent/route";

const VALID_SESSION = { user: { id: "user-uuid-123" } };

const VALID_CLIENT = {
  id: "client-db-uuid",
  clientId: "mcpc_testclient",
  isActive: true,
  tenantId: "tenant-uuid-123",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:decrypt,passwords:read",
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

function createFormRequest(url: string, fields: Record<string, string>) {
  const fd = buildFormData(fields);
  return new Request(url, { method: "POST", body: fd });
}

const VALID_FORM_FIELDS = {
  client_id: "mcpc_testclient",
  redirect_uri: "https://example.com/callback",
  scope: "credentials:decrypt",
  code_challenge: "test-challenge-value-base64url",
  code_challenge_method: "S256",
  state: "random-state-value",
};

describe("POST /api/mcp/authorize/consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(VALID_SESSION);
    // withBypassRls: first call returns client, second call returns user
    mockWithBypassRls
      .mockImplementationOnce(async (_p: unknown, fn: () => unknown) => fn())
      .mockImplementationOnce(async (_p: unknown, fn: () => unknown) => fn());
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockFindUnique.mockResolvedValue(VALID_USER);
    mockCreateAuthorizationCode.mockResolvedValue({
      code: "auth-code-abc123",
      expiresAt: new Date(Date.now() + 60000),
    });
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
    expect(json.error).toBe("unauthorized");
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
      }),
    );
  });

  it("calls logAudit after successful consent", async () => {
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
});
