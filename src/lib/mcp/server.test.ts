import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock variables ───────────────────────────────────

const { mockRateLimitCheck } = vi.hoisted(() => ({
  mockRateLimitCheck: vi.fn(),
}));

const { mockToolListCredentials, mockToolSearchCredentials, mockToolWhoami } = vi.hoisted(() => ({
  mockToolListCredentials: vi.fn(),
  mockToolSearchCredentials: vi.fn(),
  mockToolWhoami: vi.fn(),
}));

// ─── Mocks ────────────────────────────────────────────────────

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  }),
}));

vi.mock("@/lib/mcp/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/tools")>();
  return {
    ...actual,
    toolListCredentials: mockToolListCredentials,
    toolSearchCredentials: mockToolSearchCredentials,
    toolWhoami: mockToolWhoami,
  };
});

import { handleMcpRequest } from "./server";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "@/lib/constants/mcp";
import type { McpTokenData } from "@/lib/mcp/oauth-server";

// ─── Fixtures ─────────────────────────────────────────────────

const makeToken = (overrides?: Partial<McpTokenData>): McpTokenData => ({
  tokenId: "token-1",
  tenantId: "tenant-1",
  clientId: "mcpc_test",
  userId: "user-1",
  serviceAccountId: null,
  mcpClientId: "mcpc_test",
  scopes: ["credentials:list"],
  ...overrides,
});

function makeRequest(overrides?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
    ...overrides,
  };
}

// ─── Rate limiting ────────────────────────────────────────────

describe("handleMcpRequest — rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns -32029 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30000 });

    const result = await handleMcpRequest(makeRequest(), makeToken());
    expect(result).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32029 },
    });
  });
});

// ─── JSON-RPC validation ──────────────────────────────────────

describe("handleMcpRequest — JSON-RPC validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns -32600 for missing jsonrpc field", async () => {
    const result = await handleMcpRequest({ id: 1, method: "ping" }, makeToken());
    expect(result).toMatchObject({ error: { code: -32600 } });
  });

  it("returns -32600 for missing method field", async () => {
    const result = await handleMcpRequest({ jsonrpc: "2.0", id: 1 }, makeToken());
    expect(result).toMatchObject({ error: { code: -32600 } });
  });

  it("returns -32600 for wrong jsonrpc version", async () => {
    const result = await handleMcpRequest({ jsonrpc: "1.0", id: 1, method: "ping" }, makeToken());
    expect(result).toMatchObject({ error: { code: -32600 } });
  });
});

// ─── Method routing ───────────────────────────────────────────

describe("handleMcpRequest — method routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("initialize: returns protocol version, capabilities, server info", async () => {
    const result = await handleMcpRequest(makeRequest({ method: "initialize" }), makeToken());
    expect(result).toMatchObject({
      jsonrpc: "2.0",
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    });
  });

  it("ping: returns empty object", async () => {
    const result = await handleMcpRequest(makeRequest({ method: "ping" }), makeToken());
    expect(result).toMatchObject({ jsonrpc: "2.0", result: {} });
  });

  it("notifications/initialized: returns empty object", async () => {
    const result = await handleMcpRequest(
      makeRequest({ method: "notifications/initialized" }),
      makeToken(),
    );
    expect(result).toMatchObject({ jsonrpc: "2.0", result: {} });
  });

  it("unknown method: returns -32601", async () => {
    const result = await handleMcpRequest(makeRequest({ method: "unknown/method" }), makeToken());
    expect(result).toMatchObject({ error: { code: -32601 } });
  });
});

// ─── tools/list ───────────────────────────────────────────────

describe("handleMcpRequest — tools/list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns MCP_TOOLS array", async () => {
    const { MCP_TOOLS } = await import("@/lib/mcp/tools");
    const result = await handleMcpRequest(makeRequest({ method: "tools/list" }), makeToken());
    expect(result).toMatchObject({
      jsonrpc: "2.0",
      result: { tools: MCP_TOOLS },
    });
  });
});

// ─── tools/call ───────────────────────────────────────────────

describe("handleMcpRequest — tools/call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  function callRequest(params: Record<string, unknown>) {
    return makeRequest({ method: "tools/call", params });
  }

  it("missing tool name returns -32602", async () => {
    const result = await handleMcpRequest(callRequest({}), makeToken());
    expect(result).toMatchObject({ error: { code: -32602 } });
  });

  it("unknown tool returns -32601", async () => {
    const result = await handleMcpRequest(
      callRequest({ name: "nonexistent_tool" }),
      makeToken(),
    );
    expect(result).toMatchObject({ error: { code: -32601 } });
  });

  it("insufficient scope returns -32003 for list_credentials", async () => {
    const token = makeToken({ scopes: ["vault:status"] });
    const result = await handleMcpRequest(
      callRequest({ name: "list_credentials" }),
      token,
    );
    expect(result).toMatchObject({ error: { code: -32003 } });
  });

  it("list_credentials succeeds with credentials:list scope", async () => {
    mockToolListCredentials.mockResolvedValueOnce({ result: { entries: [], total: 0 } });
    const token = makeToken({ scopes: ["credentials:list"] });
    const result = await handleMcpRequest(
      callRequest({ name: "list_credentials", arguments: {} }),
      token,
    );
    expect(result).toMatchObject({
      result: {
        content: [{ type: "text" }],
      },
    });
  });

  it("search_credentials succeeds with credentials:list scope", async () => {
    mockToolSearchCredentials.mockResolvedValueOnce({ result: { entries: [], total: 0 } });
    const token = makeToken({ scopes: ["credentials:list"] });
    const result = await handleMcpRequest(
      callRequest({ name: "search_credentials", arguments: { query: "test" } }),
      token,
    );
    expect(result).toMatchObject({
      result: {
        content: [{ type: "text" }],
      },
    });
  });

  it("whoami succeeds without any scope requirement", async () => {
    mockToolWhoami.mockReturnValueOnce({ result: { clientId: "mcpc_test", userId: "user-1" } });
    const token = makeToken({ scopes: [] });
    const result = await handleMcpRequest(
      callRequest({ name: "whoami" }),
      token,
    );
    expect(result).toMatchObject({
      result: { content: [{ type: "text" }] },
    });
  });

  it("tool error propagates as JSON-RPC error", async () => {
    mockToolListCredentials.mockResolvedValueOnce({
      error: { code: -32603, message: "Internal error" },
    });
    const token = makeToken({ scopes: ["credentials:list"] });
    const result = await handleMcpRequest(
      callRequest({ name: "list_credentials", arguments: {} }),
      token,
    );
    expect(result).toMatchObject({ error: { code: -32603, message: "Internal error" } });
  });

  it("successful tool returns content array with text type", async () => {
    const toolData = { entries: [{ id: "e1", title: "GitHub" }], total: 1 };
    mockToolListCredentials.mockResolvedValueOnce({ result: toolData });
    const token = makeToken({ scopes: ["credentials:list"] });
    const result = await handleMcpRequest(
      callRequest({ name: "list_credentials", arguments: {} }),
      token,
    );
    expect(result).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(toolData),
          },
        ],
      },
    });
  });
});

// ─── hasRequiredScope (via handleMcpRequest) ──────────────────

describe("hasRequiredScope — via tools/call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("specific scope matches", async () => {
    mockToolListCredentials.mockResolvedValueOnce({ result: { entries: [], total: 0 } });
    const token = makeToken({ scopes: ["credentials:list"] });
    const result = await handleMcpRequest(
      makeRequest({ method: "tools/call", params: { name: "list_credentials" } }),
      token,
    );
    expect(result).not.toMatchObject({ error: { code: -32003 } });
  });

  it("neither specific nor legacy scope → -32003", async () => {
    const token = makeToken({ scopes: ["vault:status"] });
    const result = await handleMcpRequest(
      makeRequest({ method: "tools/call", params: { name: "list_credentials" } }),
      token,
    );
    expect(result).toMatchObject({ error: { code: -32003 } });
  });
});
