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
  const mockWithBypassRls = vi.fn(async (_p: unknown, fn: () => unknown) => fn());
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
        },
      }),
    ),
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockRateLimiterCheck }),
}));

vi.mock("@/lib/auth/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
  rateLimitKeyFromIp: mockRateLimitKeyFromIp,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  hashToken: vi.fn((token: string) => `hashed:${token}`),
}));

import { POST } from "@/app/api/mcp/register/route";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

const VALID_BODY = {
  client_name: "Test MCP Client",
  redirect_uris: ["https://example.com/callback"],
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
    mockWithBypassRls.mockImplementation(async (_p: unknown, fn: () => unknown) => fn());
  });

  it("returns 201 with client credentials on valid registration", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: VALID_BODY,
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.client_id).toBe(MOCK_CREATED_CLIENT.clientId);
    expect(json.client_secret).toBeTruthy();
    expect(typeof json.client_secret).toBe("string");
    expect(json.client_name).toBe("Test MCP Client");
    expect(json.redirect_uris).toEqual(["https://example.com/callback"]);
    expect(json.grant_types).toEqual(["authorization_code"]);
    expect(json.response_types).toEqual(["code"]);
    expect(json.token_endpoint_auth_method).toBe("client_secret_post");
    expect(json.client_id_issued_at).toBe(
      Math.floor(MOCK_CREATED_CLIENT.createdAt.getTime() / 1000),
    );
    expect(json.client_secret_expires_at).toBe(0);
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
        redirect_uris: ["http://127.0.0.1/callback"],
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

  // T-14: public client registration without client_secret
  it("registers public client without client_secret when token_endpoint_auth_method is none", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp/register", {
      body: {
        ...VALID_BODY,
        token_endpoint_auth_method: "none",
      },
    });
    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.client_id).toBeDefined();
    expect(json.client_secret).toBeUndefined();
    expect(json.client_secret_expires_at).toBeUndefined();
    expect(json.token_endpoint_auth_method).toBe("none");
  });

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
