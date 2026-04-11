import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  EXTENSION_TOKEN_SCOPE,
  EXTENSION_TOKEN_TTL_MS,
  EXTENSION_TOKEN_MAX_ACTIVE,
  type ExtensionTokenScope,
} from "@/lib/constants";

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedExtensionToken {
  tokenId: string;
  userId: string;
  scopes: ExtensionTokenScope[];
  expiresAt: Date;
}

export type TokenValidationError =
  | "EXTENSION_TOKEN_INVALID"
  | "EXTENSION_TOKEN_REVOKED"
  | "EXTENSION_TOKEN_EXPIRED";

export type TokenValidationResult =
  | { ok: true; data: ValidatedExtensionToken }
  | { ok: false; error: TokenValidationError };

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

const ALLOWED_SCOPES = new Set<string>(
  Object.values(EXTENSION_TOKEN_SCOPE),
);

/** Parse CSV scope string into typed array. Unknown scopes are dropped. */
export function parseScopes(csv: string): ExtensionTokenScope[] {
  const out: ExtensionTokenScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as ExtensionTokenScope);
    }
  }
  return out;
}

export function hasScope(
  scopes: ExtensionTokenScope[],
  required: ExtensionTokenScope,
): boolean {
  return scopes.includes(required);
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate an extension token from the Authorization header.
 * Returns a discriminated union so callers can map errors to HTTP status/codes.
 * On success, updates `lastUsedAt` (best-effort, non-blocking).
 */
export async function validateExtensionToken(
  req: NextRequest,
): Promise<TokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await withBypassRls(prisma, async () =>
    prisma.extensionToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (!token) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "EXTENSION_TOKEN_REVOKED" };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "EXTENSION_TOKEN_EXPIRED" };
  }

  // Best-effort lastUsedAt update (non-blocking)
  void withBypassRls(prisma, async () =>
    prisma.extensionToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE).catch(() => {});

  return {
    ok: true,
    data: {
      tokenId: token.id,
      userId: token.userId,
      scopes: parseScopes(token.scope),
      expiresAt: token.expiresAt,
    },
  };
}

// ─── Issuance ────────────────────────────────────────────────

/**
 * Issue a new extension token for a user/tenant pair.
 *
 * Shared between:
 * - `POST /api/extension/token` (legacy direct issuance)
 * - `POST /api/extension/token/exchange` (new bridge code flow)
 *
 * `POST /api/extension/token/refresh` does NOT use this helper because
 * refresh requires `revoke(oldToken) + create(newToken)` to be atomic in
 * a single transaction (see plan §Step 6).
 *
 * Atomicity: sets up its own `withUserTenantRls` + `prisma.$transaction`
 * internally and enforces `EXTENSION_TOKEN_MAX_ACTIVE` (revokes the oldest
 * unused tokens to make room) before creating the new token, all in a single
 * transaction. Callers do NOT need to establish an RLS context before calling.
 */
export async function issueExtensionToken(params: {
  userId: string;
  tenantId: string;
  scope: string;
}): Promise<{ token: string; expiresAt: Date; scopeCsv: string }> {
  const { userId, tenantId, scope } = params;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS);
  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Find active tokens (non-revoked, non-expired)
      const active = await tx.extensionToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Revoke oldest if at max (need room for the new one)
      const over = active.length + 1 - EXTENSION_TOKEN_MAX_ACTIVE;
      if (over > 0) {
        const toRevoke = active.slice(0, over).map((t) => t.id);
        await tx.extensionToken.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now },
        });
      }

      return tx.extensionToken.create({
        data: { userId, tenantId, tokenHash, scope, expiresAt },
        select: { expiresAt: true, scope: true },
      });
    }),
  );

  return {
    token: plaintext,
    expiresAt: created.expiresAt,
    scopeCsv: created.scope,
  };
}
