import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { SCIM_TOKEN_PREFIX } from "@/lib/scim/token-utils";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";
import { resolveAuditUserId } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/** Minimum interval (ms) between lastUsedAt updates to reduce DB writes. */
const LAST_USED_AT_THROTTLE_MS = 5 * MS_PER_MINUTE;

// ─── Types ────────────────────────────────────────────────────

export interface ValidatedScimToken {
  tokenId: string;
  tenantId: string;
  createdById: string | null;
  /** Always non-null: createdById if present, otherwise SYSTEM_ACTOR_ID sentinel. */
  auditUserId: string;
  /** HUMAN when token was created by a real user; SYSTEM when createdById is null. */
  actorType: typeof ACTOR_TYPE.HUMAN | typeof ACTOR_TYPE.SYSTEM;
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
 * 6. Return tenantId + auditUserId (SYSTEM_ACTOR_ID sentinel when createdById is null)
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

  const token = await withBypassRls(prisma, async () =>
    prisma.scimToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        createdById: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (!token) {
    return { ok: false, error: "SCIM_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "SCIM_TOKEN_REVOKED" };
  }
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "SCIM_TOKEN_EXPIRED" };
  }
  if (!token.tenantId) {
    return { ok: false, error: "SCIM_TOKEN_INVALID" };
  }

  // Best-effort lastUsedAt update — throttled to reduce DB writes
  const now = Date.now();
  const lastUsed = token.lastUsedAt?.getTime() ?? 0;
  if (now - lastUsed >= LAST_USED_AT_THROTTLE_MS) {
    void withBypassRls(prisma, async () => {
      await prisma.scimToken.update({
        where: { id: token.id },
        data: { lastUsedAt: new Date(now) },
      });
    }, BYPASS_PURPOSE.TOKEN_LIFECYCLE).catch((err) => {
      getLogger().warn({ err }, "scim.token.lastUsedAt.update_failed");
    });
  }

  return {
    ok: true,
    data: {
      tokenId: token.id,
      tenantId: token.tenantId,
      createdById: token.createdById,
      auditUserId: resolveAuditUserId(token.createdById, "system"),
      actorType: token.createdById ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.SYSTEM,
    },
  };
}
