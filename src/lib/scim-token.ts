import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { SCIM_TOKEN_PREFIX } from "@/lib/scim/token-utils";

// ─── Constants ────────────────────────────────────────────────

/** Fallback userId for audit logs when token creator has left the org. */
export const SCIM_SYSTEM_USER_ID = "system:scim";

/** Minimum interval (ms) between lastUsedAt updates to reduce DB writes. */
const LAST_USED_AT_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ────────────────────────────────────────────────────

export interface ValidatedScimToken {
  tokenId: string;
  orgId: string;
  createdById: string | null;
  /** Always non-null: createdById ?? SCIM_SYSTEM_USER_ID. */
  auditUserId: string;
}

export type ScimTokenValidationError =
  | "SCIM_TOKEN_INVALID"
  | "SCIM_TOKEN_REVOKED"
  | "SCIM_TOKEN_EXPIRED";

export type ScimTokenValidationResult =
  | { ok: true; data: ValidatedScimToken }
  | { ok: false; error: ScimTokenValidationError };

// ─── Helpers ──────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

// ─── Validation ───────────────────────────────────────────────

/**
 * Validate a SCIM token from the Authorization header.
 *
 * Flow:
 * 1. Extract Bearer token
 * 2. Verify `scim_` prefix
 * 3. SHA-256 hash → DB lookup
 * 4. Check revokedAt / expiresAt
 * 5. Best-effort lastUsedAt update (throttled to 5-min intervals)
 * 6. Return orgId + auditUserId (with SCIM_SYSTEM_USER_ID fallback)
 */
export async function validateScimToken(
  req: NextRequest,
): Promise<ScimTokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "SCIM_TOKEN_INVALID" };
  }

  // Reject tokens without the expected prefix
  if (!plaintext.startsWith(SCIM_TOKEN_PREFIX)) {
    return { ok: false, error: "SCIM_TOKEN_INVALID" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await prisma.scimToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      orgId: true,
      createdById: true,
      revokedAt: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  if (!token) {
    return { ok: false, error: "SCIM_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "SCIM_TOKEN_REVOKED" };
  }
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "SCIM_TOKEN_EXPIRED" };
  }

  // Best-effort lastUsedAt update — throttled to reduce DB writes
  const now = Date.now();
  const lastUsed = token.lastUsedAt?.getTime() ?? 0;
  if (now - lastUsed >= LAST_USED_AT_THROTTLE_MS) {
    void prisma.scimToken
      .update({
        where: { id: token.id },
        data: { lastUsedAt: new Date(now) },
      })
      .catch(() => {});
  }

  return {
    ok: true,
    data: {
      tokenId: token.id,
      orgId: token.orgId,
      createdById: token.createdById,
      auditUserId: token.createdById ?? SCIM_SYSTEM_USER_ID,
    },
  };
}
