import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../../../__tests__/helpers/request-builder";

const {
  mockPrismaCount,
  mockPrismaCreate,
  mockWithBypassRls,
  mockRateLimiterCheck,
  mockExtractClientIp,
  mockRateLimitKeyFromIp,
  mockLogAudit,
} = vi.hoisted(() => {
  const mockCount = vi.fn();
  const mockCreate = vi.fn();
  const mockWithBypassRls = vi.fn(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
  return {
    mockPrismaCount: mockCount,
    mockPrismaCreate: mockCreate,
    mockWithBypassRls,
    mockRateLimiterCheck: vi.fn().mockResolvedValue({ allowed: true }),
    mockExtractClientIp: vi.fn().mockReturnValue("127.0.0.1"),
    mockRateLimitKeyFromIp: vi.fn((ip: string) => ip),
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      count: mockPrismaCount,
      create: mockPrismaCreate,
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        mcpClient: {
          count: mockPrismaCount,
          create: mockPrismaCreate,
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }),
    ),
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: mockRateLimitKeyFromIp,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

import { POST } from "@/app/api/mcp/register/route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

// A07-4: DCR is public-only — token_endpoint_auth_method must be the literal "none".
const VALID_BODY = {
  client_name: "Test MCP Client",
  redirect_uris: ["https://example.com/callback"],
  token_endpoint_auth_method: "none" as const,
};

const MOCK_CREATED_CLIENT = {
  id: "client-db-uuid",
  clientId: "mcpc_abcdef1234567890abcdef1234567890",
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

describe("POST /api/mcp/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterCheck.mockResolvedValue({ allowed: true });
    mockPrismaCount.mockResolvedValue(0);
    mockPrismaCreate.mockResolvedValue(MOCK_CREATED_CLIENT);
    // withBypassRls executes the callback inline; first call is count, second is create
    mockWithBypassRls.mockImplementation(async (p: unknown, fn: (tx: unknown) => unknown) => fn(p));
  });

  // A07-4 T-1: positive — DCR issues public client with empty clientSecretHash.
  it("returns 201 with public client (no secret) on valid registration", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.client_id).toBe(MOCK_CREATED_CLIENT.clientId);
    // A07-4: public-only — no client_secret in response.
    expect(json.client_secret).toBeUndefined();
    expect(json.client_secret_expires_at).toBeUndefined();
    expect(json.token_endpoint_auth_method).toBe("none");
    expect(json.client_name).toBe("Test MCP Client");
    expect(json.redirect_uris).toEqual(["https://example.com/callback"]);
    expect(json.grant_types).toEqual(["authorization_code"]);
    expect(json.response_types).toEqual(["code"]);
    expect(json.client_id_issued_at).toBe(
      Math.floor(MOCK_CREATED_CLIENT.createdAt.getTime() / 1000),
    );

    // A07-4 T-1: assert DB-write contract — clientSecretHash MUST be the empty
    // string for DCR clients (public-only sentinel; matches downstream check
    // in oauth-server.ts:`clientSecretHash === ""`). Direct value assertion so
    // any non-empty hash (regression) flips this test red.
    const createCall = mockPrismaCreate.mock.calls[0]?.[0] as
      | { data: { clientSecretHash: string; isDcr: boolean } }
      | undefined;
    expect(createCall?.data.clientSecretHash).toBe("");
    expect(createCall?.data.isDcr).toBe(true);
  });

  it("returns 400 with invalid_client_metadata when client_name is missing", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: { redirect_uris: ["https://example.com/callback"] },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("returns 400 when redirect_uris is empty array", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: { client_name: "Test", redirect_uris: [] },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("accepts https:// redirect URIs", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["https://app.example.com/callback"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
  });

  it("accepts http://127.0.0.1:<port>/ loopback redirect URIs (RFC 8252 §7.3)", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://127.0.0.1:3000/callback"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
  });

  it("accepts http://localhost with port redirect URIs", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
  });

  it("rejects http://localhost without port redirect URIs", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://localhost/callback"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("rejects http://127.0.0.1/ without port", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://127.0.0.1/callback"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("accepts http://[::1]:<port>/ IPv6 loopback redirect URIs (RFC 8252 §7.3)", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://[::1]:3000/callback"],
      },
    });
    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
  });

  it("rejects http://[::1]/ IPv6 loopback without port", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://[::1]/callback"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("rejects plain http:// (non-loopback) redirect URIs", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        client_name: "Test",
        token_endpoint_auth_method: "none",
        redirect_uris: ["http://example.com/callback"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("returns 400 when grant_types is provided without authorization_code", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        ...VALID_BODY,
        grant_types: ["client_credentials"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("returns 400 when response_types is provided without code", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        ...VALID_BODY,
        response_types: ["token"],
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterMs: 60000 });

    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("rate_limit_exceeded");
  });

  it("returns 503 when MAX_UNCLAIMED_DCR_CLIENTS cap is reached", async () => {
    // $transaction injects tx with mockPrismaCount — set it to return cap value
    mockPrismaCount.mockResolvedValueOnce(100);

    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(503);
    expect(json.error).toBe("temporarily_unavailable");
    // C3 acceptance: 503 body must include the literal "dcr-cleanup-worker"
    // so an operator hitting registration outages knows which process to
    // check. Tests pin the literal because the C3 removal of the
    // probabilistic cleanup made the worker the sole cleanup path.
    expect(json.error_description).toContain("dcr-cleanup-worker");
  });

  it("returns 400 when request body is invalid JSON", async () => {
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/mcp/register",
      {
        method: "POST",
        body: "not-json",
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  // A07-4 T-2: wrong-shape rejection — every non-"none" value is rejected with
  // invalid_client_metadata and the error_description references RFC 9700 §4.14.
  // Covers the legacy "client_secret_post" default that pre-A07-4 was accepted,
  // plus exotic shapes a buggy/malicious client might send (unicode look-alikes,
  // very long strings, object/array shapes).
  it.each([
    { name: "absent", body: {} as Record<string, unknown> },
    { name: "null", body: { token_endpoint_auth_method: null } },
    { name: "undefined (explicit)", body: { token_endpoint_auth_method: undefined } },
    { name: "empty string", body: { token_endpoint_auth_method: "" } },
    { name: "capital N (case mismatch)", body: { token_endpoint_auth_method: "None" } },
    { name: "whitespace padding", body: { token_endpoint_auth_method: " none " } },
    { name: "array containing none", body: { token_endpoint_auth_method: ["none"] } },
    { name: "object value", body: { token_endpoint_auth_method: { method: "none" } } },
    { name: "number", body: { token_endpoint_auth_method: 0 } },
    { name: "boolean", body: { token_endpoint_auth_method: false } },
    { name: "zero-width space (unicode look-alike)", body: { token_endpoint_auth_method: "none​" } },
    { name: "very long string", body: { token_endpoint_auth_method: "none" + "x".repeat(10_000) } },
    { name: "legacy client_secret_post", body: { token_endpoint_auth_method: "client_secret_post" } },
    { name: "client_secret_basic", body: { token_endpoint_auth_method: "client_secret_basic" } },
  ])(
    "A07-4: rejects token_endpoint_auth_method = $name with invalid_client_metadata + RFC 9700 §4.14",
    async ({ body }) => {
      const req = createRequest("POST", "http://localhost/api/mcp/register", {
        body: {
          client_name: "Test",
          redirect_uris: ["https://example.com/callback"],
          ...body,
        },
      });
      const res = await POST(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(400);
      expect(json.error).toBe("invalid_client_metadata");
      // Pin the RFC reference exactly so accidental softening
      // ("Per RFC 9700" or no section) flips the test red.
      expect(json.error_description).toMatch(/RFC 9700 §4\.14/);
      expect(mockPrismaCreate).not.toHaveBeenCalled();
    },
  );

  it("calls logAuditAsync after successful registration", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "SYSTEM",
        targetId: MOCK_CREATED_CLIENT.id,
        metadata: expect.objectContaining({ client_name: "Test MCP Client" }),
      }),
    );
  });

  // T3.2: DCR registration always uses SYSTEM_ACTOR_ID (no user context at registration time)
  it("logAuditAsync is called with userId=SYSTEM_ACTOR_ID for anonymous DCR registration", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    await POST(req);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SYSTEM_ACTOR_ID,
        actorType: "SYSTEM",
      }),
    );
  });
});
