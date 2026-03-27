import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { withBypassRls } from "@/lib/tenant-rls";
import {
  SA_TOKEN_PREFIX,
  SA_TOKEN_SCOPE,
  SA_TOKEN_LAST_USED_THROTTLE_MS,
  type SaTokenScope,
} from "@/lib/constants/service-account";

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedServiceAccountToken {
  tokenId: string;
  serviceAccountId: string;
  tenantId: string;
  scopes: SaTokenScope[];
}

export type SaTokenValidationError =
  | "INVALID_TOKEN_TYPE"
  | "SA_TOKEN_INVALID"
  | "SA_TOKEN_REVOKED"
  | "SA_TOKEN_EXPIRED"
  | "SA_INACTIVE";

export type SaTokenValidationResult =
  | { ok: true; data: ValidatedServiceAccountToken }
  | { ok: false; error: SaTokenValidationError };

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

const ALLOWED_SCOPES = new Set<string>(Object.values(SA_TOKEN_SCOPE));

/** Parse CSV scope string into typed array. Unknown scopes are dropped. */
export function parseSaTokenScopes(csv: string): SaTokenScope[] {
  const out: SaTokenScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as SaTokenScope);
    }
  }
  return out;
}

export function hasSaTokenScope(
  scopes: SaTokenScope[],
  required: SaTokenScope,
): boolean {
  return scopes.includes(required);
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate a service account token from the Authorization header.
 * Only accepts tokens with the `sa_` prefix.
 * Also verifies that the parent ServiceAccount is active.
 */
export async function validateServiceAccountToken(
  req: NextRequest,
): Promise<SaTokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  if (!plaintext.startsWith(SA_TOKEN_PREFIX)) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await withBypassRls(prisma, async () =>
    prisma.serviceAccountToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        serviceAccountId: true,
        tenantId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        serviceAccount: {
          select: { isActive: true },
        },
      },
    }),
  );

  if (!token) {
    return { ok: false, error: "SA_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "SA_TOKEN_REVOKED" };
  }
  if (!token.expiresAt || token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "SA_TOKEN_EXPIRED" };
  }
  if (!token.serviceAccount.isActive) {
    return { ok: false, error: "SA_INACTIVE" };
  }

  // Throttled lastUsedAt update (non-blocking)
  const shouldUpdate =
    !token.lastUsedAt ||
    Date.now() - token.lastUsedAt.getTime() > SA_TOKEN_LAST_USED_THROTTLE_MS;
  if (shouldUpdate) {
    void withBypassRls(prisma, async () =>
      prisma.serviceAccountToken.update({
        where: { id: token.id },
        data: { lastUsedAt: new Date() },
      }),
    ).catch(() => {});
  }

  return {
    ok: true,
    data: {
      tokenId: token.id,
      serviceAccountId: token.serviceAccountId,
      tenantId: token.tenantId,
      scopes: parseSaTokenScopes(token.scope),
    },
  };
}
