/**
 * MCP Streamable HTTP server core.
 *
 * Implements JSON-RPC 2.0 dispatch for MCP protocol (2025-03-26).
 * Supported methods: initialize, ping, tools/list, tools/call
 *
 * Transport: direct JSON response (no SSE streaming — simplicity first).
 * Rate limiting: per client_id using Redis.
 */

import { createRateLimiter } from "@/lib/rate-limit";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "@/lib/constants/mcp";
import { MCP_TOOLS, toolListCredentials, toolSearchCredentials, toolWhoami } from "@/lib/mcp/tools";
import type { McpTokenData } from "@/lib/mcp/oauth-server";
import { MCP_SCOPE, type McpScope } from "@/lib/constants/mcp";

// ─── Tool → required scope mapping ───────────────────────────

const TOOL_SCOPE_MAP: Record<string, McpScope> = {
  list_credentials: MCP_SCOPE.CREDENTIALS_LIST,
  search_credentials: MCP_SCOPE.CREDENTIALS_LIST,
};

function hasRequiredScope(tokenScopes: string[], required: string): boolean {
  return tokenScopes.includes(required);
}

// ─── Rate limiting ────────────────────────────────────────────

const mcpRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

// ─── JSON-RPC types ───────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function ok(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ─── Method handlers ──────────────────────────────────────────

function handleInitialize(id: string | number | null): JsonRpcResponse {
  return ok(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
  });
}

function handleToolsList(id: string | number | null): JsonRpcResponse {
  return ok(id, { tools: MCP_TOOLS });
}

async function handleToolsCall(
  id: string | number | null,
  params: unknown,
  token: McpTokenData,
  ip?: string | null,
): Promise<JsonRpcResponse> {
  const p = params as { name?: string; arguments?: unknown };
  if (!p?.name) return err(id, -32602, "Missing tool name");

  // Scope enforcement
  const requiredScope = TOOL_SCOPE_MAP[p.name];
  if (requiredScope && !hasRequiredScope(token.scopes, requiredScope)) {
    return err(id, -32003, `Insufficient scope: requires ${requiredScope}`);
  }

  let toolResult: { result?: unknown; error?: { code: number; message: string; data?: unknown } };

  switch (p.name) {
    case "list_credentials":
      toolResult = await toolListCredentials(token, p.arguments, ip);
      break;
    case "search_credentials":
      toolResult = await toolSearchCredentials(token, p.arguments, ip);
      break;
    case "whoami":
      toolResult = toolWhoami(token);
      break;
    default:
      return err(id, -32601, `Unknown tool: ${p.name}`);
  }

  if (toolResult.error) {
    return err(id, toolResult.error.code, toolResult.error.message, toolResult.error.data);
  }

  return ok(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(toolResult.result),
      },
    ],
  });
}

// ─── Main dispatcher ──────────────────────────────────────────

export async function handleMcpRequest(
  body: unknown,
  token: McpTokenData,
  ip?: string | null,
): Promise<JsonRpcResponse> {
  // Rate limit by client_id
  const rlResult = await mcpRateLimiter.check(`mcp:${token.clientId}`);
  if (!rlResult.allowed) {
    return err(null, -32029, "Rate limit exceeded");
  }

  const req = body as Partial<JsonRpcRequest>;
  if (req.jsonrpc !== "2.0" || !req.method) {
    return err(req.id ?? null, -32600, "Invalid Request");
  }

  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return handleInitialize(id);
    case "ping":
      return ok(id, {});
    case "notifications/initialized":
      // Client notification — no response needed (but return empty result for HTTP transport)
      return ok(id, {});
    case "tools/list":
      return handleToolsList(id);
    case "tools/call":
      return handleToolsCall(id, req.params, token, ip);
    default:
      return err(id, -32601, `Method not found: ${req.method}`);
  }
}
