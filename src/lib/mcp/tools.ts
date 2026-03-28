/**
 * MCP tool implementations.
 *
 * All tools require an active delegation session. Only delegated
 * (pre-approved) entries are returned, always as plaintext.
 * The server retrieves plaintext from Redis envelope-encrypted cache.
 *
 * Tool inputs are strictly typed with Zod (no URL args — SSRF prevention).
 */

import { z } from "zod";
import type { McpTokenData } from "@/lib/mcp/oauth-server";
import {
  findActiveDelegationSession,
  fetchDelegationEntry,
  getDelegatedEntryIds,
  type DelegationEntryData,
} from "@/lib/delegation";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";

// ─── Tool definitions ─────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: "list_credentials",
    description:
      "List delegated credential entries. Returns plaintext overviews for entries " +
      "the user has pre-approved via the vault UI. Requires credentials:decrypt scope " +
      "and an active delegation session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_credential",
    description:
      "Get a single delegated credential by ID. Returns plaintext fields (title, username, " +
      "password, url, notes). Requires credentials:decrypt scope and an active delegation session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Credential entry UUID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_credentials",
    description:
      "Search delegated credential entries by keyword. Searches title and username fields " +
      "of delegated entries. Requires credentials:decrypt scope and an active delegation session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword (matches title or username)" },
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
      },
      additionalProperties: false,
    },
  },
] as const;

// ─── Input schemas ────────────────────────────────────────────

const listCredentialsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const getCredentialSchema = z.object({
  id: z.string().uuid(),
});

const searchCredentialsSchema = z.object({
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

// ─── Helpers ─────────────────────────────────────────────────

function requireDelegation(token: McpTokenData) {
  if (!token.userId) {
    return { error: { code: -32603, message: "Service account tokens cannot access credentials" } };
  }
  return null;
}

async function getSession(token: McpTokenData) {
  const session = await findActiveDelegationSession(token.userId!, token.tokenId);
  if (!session) {
    return { error: { code: -32603, message: "No active delegation session. Delegate entries via the vault UI first." } };
  }
  return { session };
}

function auditRead(token: McpTokenData, targetId: string, sessionId: string, ip?: string | null) {
  const auditBase = {
    action: AUDIT_ACTION.DELEGATION_READ,
    userId: token.userId!,
    actorType: "MCP_AGENT" as const,
    tenantId: token.tenantId,
    targetId,
    metadata: { delegationSessionId: sessionId, mcpClientId: token.clientId },
    ip: ip ?? undefined,
  };
  logAudit({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL });
  logAudit({ ...auditBase, scope: AUDIT_SCOPE.TENANT });
}

// ─── Tool handlers ────────────────────────────────────────────

export async function toolListCredentials(
  token: McpTokenData,
  rawInput: unknown,
  ip?: string | null,
) {
  const parsed = listCredentialsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { limit, offset } = parsed.data;

  const guard = requireDelegation(token);
  if (guard) return guard;

  const result = await getSession(token);
  if ("error" in result) return result;
  const { session } = result;

  // Get all delegated entry IDs from Redis index
  const delegatedIds = await getDelegatedEntryIds(token.userId!, token.tokenId).catch(() => new Set<string>());
  if (delegatedIds.size === 0) {
    return { result: { entries: [] } };
  }

  // Fetch plaintext for each delegated entry
  const entries: DelegationEntryData[] = [];
  for (const entryId of delegatedIds) {
    const entry = await fetchDelegationEntry(token.userId!, session.id, entryId);
    if (entry) entries.push(entry);
  }

  // Apply pagination
  const paginated = entries.slice(offset, offset + limit);

  for (const entry of paginated) {
    auditRead(token, entry.id, session.id, ip);
  }

  return { result: { entries: paginated, total: entries.length } };
}

export async function toolGetCredential(
  token: McpTokenData,
  rawInput: unknown,
  ip?: string | null,
) {
  const parsed = getCredentialSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { id } = parsed.data;

  const guard = requireDelegation(token);
  if (guard) return guard;

  const result = await getSession(token);
  if ("error" in result) return result;
  const { session } = result;

  const entry = await fetchDelegationEntry(token.userId!, session.id, id);
  if (!entry) {
    return { error: { code: -32603, message: "Entry not delegated or delegation expired" } };
  }

  auditRead(token, id, session.id, ip);

  return { result: { entry } };
}

export async function toolSearchCredentials(
  token: McpTokenData,
  rawInput: unknown,
  ip?: string | null,
) {
  const parsed = searchCredentialsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { query, limit } = parsed.data;

  const guard = requireDelegation(token);
  if (guard) return guard;

  const result = await getSession(token);
  if ("error" in result) return result;
  const { session } = result;

  const delegatedIds = await getDelegatedEntryIds(token.userId!, token.tokenId).catch(() => new Set<string>());
  if (delegatedIds.size === 0) {
    return { result: { entries: [] } };
  }

  const entries: DelegationEntryData[] = [];
  for (const entryId of delegatedIds) {
    const entry = await fetchDelegationEntry(token.userId!, session.id, entryId);
    if (entry) entries.push(entry);
  }

  // Filter by query if provided
  const filtered = query
    ? entries.filter((e) => {
        const q = query.toLowerCase();
        return e.title.toLowerCase().includes(q) || (e.username?.toLowerCase().includes(q) ?? false);
      })
    : entries;

  const results = filtered.slice(0, limit);

  for (const entry of results) {
    auditRead(token, entry.id, session.id, ip);
  }

  return { result: { entries: results } };
}
