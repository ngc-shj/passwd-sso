/**
 * MCP tool implementations.
 *
 * All tools require an active delegation session. Only delegated
 * (pre-approved) entries are returned as metadata only — no secrets.
 * Secret fields (password, notes, url) are never returned to the AI.
 *
 * Tool inputs are strictly typed with Zod (no URL args — SSRF prevention).
 */

import { z } from "zod";
import type { McpTokenData } from "@/lib/mcp/oauth-server";
import {
  findActiveDelegationSession,
  fetchDelegationEntry,
  getDelegatedEntryIdsForSession,
  type DelegationMetadata,
} from "@/lib/auth/access/delegation";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";

// ─── Tool definitions ─────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: "list_credentials",
    description:
      "List delegated credential entries. Returns metadata only (title, username, urlHost, tags) " +
      "for entries the user has pre-approved via the vault UI. " +
      "Requires credentials:list scope and an active delegation session.",
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
    name: "search_credentials",
    description:
      "Search delegated credential entries by keyword. Searches title and username fields " +
      "of delegated entries. Returns metadata only (no secrets). " +
      "Requires credentials:list scope and an active delegation session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword (matches title or username). Omit to list all delegated entries." },
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "whoami",
    description:
      "Returns the MCP client identity (client ID, scopes). " +
      "Use this to obtain the mcpc_xxx client ID needed for CLI decrypt commands. " +
      "Requires no special scope.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

// ─── Input schemas ────────────────────────────────────────────

const listCredentialsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const searchCredentialsSchema = z.object({
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
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

async function auditDelegationAccess(
  token: McpTokenData,
  tool: "list" | "search",
  sessionId: string,
  ip?: string | null,
  extra?: { entryCount?: number; query?: string },
) {
  const auditBase = {
    action: AUDIT_ACTION.DELEGATION_READ,
    userId: token.userId!,
    actorType: ACTOR_TYPE.MCP_AGENT,
    tenantId: token.tenantId,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    metadata: {
      tool,
      delegationSessionId: sessionId,
      mcpClientId: token.mcpClientId,
      ...(extra?.entryCount !== undefined ? { entryCount: extra.entryCount } : {}),
      ...(extra?.query ? { query: extra.query } : {}),
    },
    ip: ip ?? undefined,
  };
  await Promise.all([
    logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL }),
    logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.TENANT }),
  ]);
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

  // Get all delegated entry IDs from Redis index (uses session.id directly — no double DB lookup)
  const delegatedIds = await getDelegatedEntryIdsForSession(token.userId!, session.id).catch(() => new Set<string>());

  // Fetch metadata for each delegated entry
  const entries: DelegationMetadata[] = [];
  for (const entryId of delegatedIds) {
    const entry = await fetchDelegationEntry(token.userId!, session.id, entryId);
    if (entry) entries.push(entry);
  }

  // Apply pagination
  const paginated = entries.slice(offset, offset + limit);

  await auditDelegationAccess(token, "list", session.id, ip, { entryCount: paginated.length });

  return { result: { entries: paginated, total: entries.length } };
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
  const { query: rawQuery, limit, offset } = parsed.data;
  const query = rawQuery?.trim() || undefined;

  const guard = requireDelegation(token);
  if (guard) return guard;

  const result = await getSession(token);
  if ("error" in result) return result;
  const { session } = result;

  const delegatedIds = await getDelegatedEntryIdsForSession(token.userId!, session.id).catch(() => new Set<string>());

  const entries: DelegationMetadata[] = [];
  for (const entryId of delegatedIds) {
    const entry = await fetchDelegationEntry(token.userId!, session.id, entryId);
    if (entry) entries.push(entry);
  }

  // Filter by query if provided — search only title and username (no secret fields)
  const filtered = query
    ? entries.filter((e) => {
        const q = query.toLowerCase();
        return e.title.toLowerCase().includes(q) || (e.username?.toLowerCase().includes(q) ?? false);
      })
    : entries;

  const paginated = filtered.slice(offset, offset + limit);

  await auditDelegationAccess(token, "search", session.id, ip, { entryCount: paginated.length, query });

  return { result: { entries: paginated, total: filtered.length } };
}

export function toolWhoami(token: McpTokenData) {
  return {
    result: {
      mcpClientId: token.mcpClientId,
      scopes: token.scopes,
    },
  };
}
