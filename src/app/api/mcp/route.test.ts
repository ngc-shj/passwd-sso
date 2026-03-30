import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "../../../__tests__/helpers/request-builder";

const {
  mockValidateMcpToken,
  mockHandleMcpRequest,
} = vi.hoisted(() => ({
  mockValidateMcpToken: vi.fn(),
  mockHandleMcpRequest: vi.fn(),
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  validateMcpToken: mockValidateMcpToken,
}));
vi.mock("@/lib/mcp/server", () => ({
  handleMcpRequest: mockHandleMcpRequest,
}));

import { POST, GET } from "@/app/api/mcp/route";

const VALID_TOKEN_DATA = {
  tokenId: "token-id",
  tenantId: "tenant-uuid",
  clientId: "client-uuid",
  userId: "user-uuid",
  serviceAccountId: null,
  scopes: ["credentials:read"],
};

describe("POST /api/mcp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without Authorization header", async () => {
    const req = createRequest("POST", "http://localhost/api/mcp", {
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe(-32001);
  });

  it("returns 401 when token validation fails", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: false, error: "invalid_token" });

    const req = createRequest("POST", "http://localhost/api/mcp", {
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
      headers: { authorization: "Bearer mcp_invalid_token" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe(-32001);
  });

  it("dispatches JSON-RPC request with valid MCP token", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: true, data: VALID_TOKEN_DATA });
    const mockResponse = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    mockHandleMcpRequest.mockResolvedValue(mockResponse);

    const req = createRequest("POST", "http://localhost/api/mcp", {
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
      headers: { authorization: "Bearer mcp_valid_token" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(mockResponse);
    expect(mockHandleMcpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "tools/list" }),
      VALID_TOKEN_DATA,
      null,
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: true, data: VALID_TOKEN_DATA });

    // Create request with invalid JSON body manually
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer mcp_valid_token",
        },
        body: "not-valid-json{{{",
      },
    );
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe(-32700);
  });
});

describe("GET /api/mcp (SSE endpoint)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 without Authorization header", async () => {
    const req = createRequest("GET", "http://localhost/api/mcp");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns 401 when token validation fails", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: false, error: "token_expired" });

    const req = createRequest("GET", "http://localhost/api/mcp", {
      headers: { authorization: "Bearer mcp_expired_token" },
    });
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("returns SSE stream with valid MCP token", async () => {
    mockValidateMcpToken.mockResolvedValue({ ok: true, data: VALID_TOKEN_DATA });

    const req = createRequest("GET", "http://localhost/api/mcp", {
      headers: { authorization: "Bearer mcp_valid_token" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    // Read SSE stream body
    const text = await res.text();
    expect(text).toContain("event: endpoint");
    expect(text).toContain("data: /api/mcp");
  });
});
