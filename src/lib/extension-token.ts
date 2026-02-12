import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import {
  EXTENSION_TOKEN_SCOPE,
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

  const token = await prisma.extensionToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      scope: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

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
  void prisma.extensionToken
    .update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

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
