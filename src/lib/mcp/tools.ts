/**
 * MCP tool implementations.
 *
 * All tools return encrypted data only — the server never sees plaintext.
 * E2E encryption is preserved: AI agents receive encrypted blobs.
 *
 * Tool inputs are strictly typed with Zod (no URL args — SSRF prevention).
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import type { McpTokenData } from "@/lib/mcp/oauth-server";
import { findActiveDelegationSession, fetchDelegationEntry, getDelegatedEntryIds } from "@/lib/delegation";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";

// ─── Tool definitions ─────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: "list_credentials",
    description:
      "List encrypted credential entries. Returns encrypted overviews — decrypt client-side with vault key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max entries to return (default 50, max 200)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
        folderId: { type: "string", description: "Filter by folder UUID" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_credential",
    description:
      "Get a single encrypted credential entry by ID. Returns encrypted blob — decrypt client-side.",
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
      "Return encrypted credential overviews for client-side search and filtering.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max entries to return (default 100, max 200)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_decrypted_credential",
    description:
      "Retrieve plaintext credentials for a pre-approved entry. " +
      "Only returns data if the user has explicitly delegated this entry via the vault UI. " +
      "Requires credentials:decrypt scope and an active delegation session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Credential entry UUID (must be pre-approved via delegation)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

// ─── Input schemas ────────────────────────────────────────────

const listCredentialsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  folderId: z.string().uuid().optional(),
});

const getCredentialSchema = z.object({
  id: z.string().uuid(),
});

const searchCredentialsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
});

// ─── Tool handlers ────────────────────────────────────────────

export async function toolListCredentials(
  token: McpTokenData,
  rawInput: unknown,
) {
  const parsed = listCredentialsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { limit, offset, folderId } = parsed.data;

  // Only userId-based tokens can access personal credentials
  if (!token.userId) {
    return { error: { code: -32603, message: "Service account tokens cannot list personal credentials" } };
  }

  const entries = await withBypassRls(prisma, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: token.userId!,
        tenantId: token.tenantId,
        deletedAt: null,
        isArchived: false,
        ...(folderId ? { folderId } : {}),
      },
      select: {
        id: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        keyVersion: true,
        aadVersion: true,
        entryType: true,
        isFavorite: true,
        createdAt: true,
        updatedAt: true,
        folderId: true,
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
  );

  // Mark delegated entries
  const delegatedIds = await getDelegatedEntryIds(token.userId!, token.tokenId).catch(() => new Set<string>());
  const enriched = entries.map((e) => ({
    ...e,
    delegated: delegatedIds.has(e.id),
  }));

  return { result: { entries: enriched } };
}

export async function toolGetCredential(
  token: McpTokenData,
  rawInput: unknown,
) {
  const parsed = getCredentialSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { id } = parsed.data;

  if (!token.userId) {
    return { error: { code: -32603, message: "Service account tokens cannot access personal credentials" } };
  }

  const entry = await withBypassRls(prisma, async () =>
    prisma.passwordEntry.findFirst({
      where: {
        id,
        userId: token.userId!,
        tenantId: token.tenantId,
        deletedAt: null,
      },
      select: {
        id: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        keyVersion: true,
        aadVersion: true,
        entryType: true,
        isFavorite: true,
        createdAt: true,
        updatedAt: true,
        folderId: true,
      },
    }),
  );

  if (!entry) {
    return { error: { code: -32603, message: "Credential not found" } };
  }

  return { result: { entry } };
}

export async function toolSearchCredentials(
  token: McpTokenData,
  rawInput: unknown,
) {
  const parsed = searchCredentialsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { limit, offset } = parsed.data;

  if (!token.userId) {
    return { error: { code: -32603, message: "Service account tokens cannot access personal credentials" } };
  }

  // Return all overviews for client-side search (encrypted, server can't filter by content)
  const entries = await withBypassRls(prisma, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: token.userId!,
        tenantId: token.tenantId,
        deletedAt: null,
        isArchived: false,
      },
      select: {
        id: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        keyVersion: true,
        entryType: true,
        updatedAt: true,
        folderId: true,
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
  );

  return { result: { entries } };
}

export async function toolGetDecryptedCredential(
  token: McpTokenData,
  rawInput: unknown,
  ip?: string | null,
) {
  const parsed = getCredentialSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { error: { code: -32602, message: "Invalid params", data: parsed.error.issues } };
  }
  const { id } = parsed.data;

  if (!token.userId) {
    return { error: { code: -32603, message: "Service account tokens cannot access delegated credentials" } };
  }

  // Find active delegation session for this MCP token
  const session = await findActiveDelegationSession(token.userId, token.tokenId);
  if (!session) {
    return { error: { code: -32603, message: "No active delegation session for this token" } };
  }

  // Fetch decrypted entry from Redis
  const entry = await fetchDelegationEntry(token.userId, session.id, id);
  if (!entry) {
    return { error: { code: -32603, message: "Entry not delegated or delegation expired" } };
  }

  // Audit log — both personal and tenant scope
  const auditBase = {
    action: AUDIT_ACTION.DELEGATION_READ,
    userId: token.userId,
    actorType: "MCP_AGENT" as const,
    tenantId: token.tenantId,
    targetId: id,
    metadata: { delegationSessionId: session.id, mcpClientId: token.clientId },
    ip: ip ?? undefined,
  };
  logAudit({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL });
  logAudit({ ...auditBase, scope: AUDIT_SCOPE.TENANT });

  return { result: { entry } };
}
