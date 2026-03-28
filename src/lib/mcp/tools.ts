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

  return { result: { entries } };
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
