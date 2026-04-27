import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  OPERATOR_TOKEN_PREFIX,
  OPERATOR_TOKEN_SCOPE,
  OPERATOR_TOKEN_LAST_USED_THROTTLE_MS,
  OPERATOR_TOKEN_PLAINTEXT_RE,
  type OperatorTokenScope,
} from "@/lib/constants/auth/operator-token";

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedOperatorToken {
  tokenId: string;
  subjectUserId: string;
  tenantId: string;
  scopes: readonly OperatorTokenScope[];
}

export type OperatorTokenValidationError =
  | "INVALID_TOKEN_TYPE"
  | "OPERATOR_TOKEN_INVALID"
  | "OPERATOR_TOKEN_REVOKED"
  | "OPERATOR_TOKEN_EXPIRED";

export type OperatorTokenValidationResult =
  | { ok: true; data: ValidatedOperatorToken }
  | { ok: false; error: OperatorTokenValidationError };

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

const ALLOWED_SCOPES = new Set<string>(Object.values(OPERATOR_TOKEN_SCOPE));

/** Parse CSV scope string into typed array. Unknown scopes are dropped. */
export function parseOperatorTokenScopes(csv: string): OperatorTokenScope[] {
  const out: OperatorTokenScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as OperatorTokenScope);
    }
  }
  return out;
}

export function hasOperatorTokenScope(
  scopes: readonly OperatorTokenScope[],
  required: OperatorTokenScope,
): boolean {
  return scopes.includes(required);
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate an operator token from the Authorization header.
 * Only accepts tokens with the `op_` prefix and correct format.
 * Does NOT re-check OWNER/ADMIN membership — that is the caller's job.
 */
export async function validateOperatorToken(
  req: NextRequest,
): Promise<OperatorTokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  if (!plaintext.startsWith(OPERATOR_TOKEN_PREFIX)) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  // Avoid leaking which check failed (prefix vs full format)
  if (!OPERATOR_TOKEN_PLAINTEXT_RE.test(plaintext)) {
    return { ok: false, error: "OPERATOR_TOKEN_INVALID" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await withBypassRls(
    prisma,
    async () =>
      prisma.operatorToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          subjectUserId: true,
          tenantId: true,
          scope: true,
          expiresAt: true,
          revokedAt: true,
          lastUsedAt: true,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  if (!token) {
    return { ok: false, error: "OPERATOR_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "OPERATOR_TOKEN_REVOKED" };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "OPERATOR_TOKEN_EXPIRED" };
  }

  // Throttled lastUsedAt update (non-blocking)
  const shouldUpdate =
    !token.lastUsedAt ||
    Date.now() - token.lastUsedAt.getTime() > OPERATOR_TOKEN_LAST_USED_THROTTLE_MS;
  if (shouldUpdate) {
    void withBypassRls(
      prisma,
      async () =>
        prisma.operatorToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date() },
        }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE,
    ).catch(() => {});
  }

  return {
    ok: true,
    data: {
      tokenId: token.id,
      subjectUserId: token.subjectUserId,
      tenantId: token.tenantId,
      scopes: parseOperatorTokenScopes(token.scope),
    },
  };
}
