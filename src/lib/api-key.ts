import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { withBypassRls } from "@/lib/tenant-rls";
import {
  API_KEY_PREFIX,
  API_KEY_SCOPE,
  type ApiKeyScope,
} from "@/lib/constants/api-key";

// ─── Types ───────────────────────────────────────────────────

export interface ValidatedApiKey {
  apiKeyId: string;
  userId: string;
  tenantId: string;
  scopes: ApiKeyScope[];
}

export type ApiKeyValidationError =
  | "INVALID_TOKEN_TYPE"
  | "API_KEY_INVALID"
  | "API_KEY_REVOKED"
  | "API_KEY_EXPIRED";

export type ApiKeyValidationResult =
  | { ok: true; data: ValidatedApiKey }
  | { ok: false; error: ApiKeyValidationError };

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

const ALLOWED_SCOPES = new Set<string>(Object.values(API_KEY_SCOPE));

/** Parse CSV scope string into typed array. Unknown scopes are dropped. */
export function parseApiKeyScopes(csv: string): ApiKeyScope[] {
  const out: ApiKeyScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as ApiKeyScope);
    }
  }
  return out;
}

export function hasApiKeyScope(
  scopes: ApiKeyScope[],
  required: ApiKeyScope,
): boolean {
  return scopes.includes(required);
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate an API key from the Authorization header.
 * Only accepts tokens with the `api_` prefix.
 */
export async function validateApiKey(
  req: NextRequest,
): Promise<ApiKeyValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  if (!plaintext.startsWith(API_KEY_PREFIX)) {
    return { ok: false, error: "INVALID_TOKEN_TYPE" };
  }

  const tokenHash = hashToken(plaintext);

  const key = await withBypassRls(prisma, async () =>
    prisma.apiKey.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
  );

  if (!key) {
    return { ok: false, error: "API_KEY_INVALID" };
  }
  if (key.revokedAt) {
    return { ok: false, error: "API_KEY_REVOKED" };
  }
  if (key.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "API_KEY_EXPIRED" };
  }

  // Best-effort lastUsedAt update (non-blocking)
  void withBypassRls(prisma, async () =>
    prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    }),
  ).catch(() => {});

  return {
    ok: true,
    data: {
      apiKeyId: key.id,
      userId: key.userId,
      tenantId: key.tenantId,
      scopes: parseApiKeyScopes(key.scope),
    },
  };
}

/**
 * Validate API key only — rejects session and extension tokens.
 * For use in /api/v1/* routes (CSRF prevention).
 *
 * @param requiredScope - If provided, checks that the key has this scope.
 * Returns 401-type errors for auth failures, 403-type for scope mismatch.
 */
export async function validateApiKeyOnly(
  req: NextRequest,
  requiredScope?: ApiKeyScope,
): Promise<
  | { ok: true; data: ValidatedApiKey }
  | { ok: false; error: ApiKeyValidationError | "SCOPE_INSUFFICIENT"; status: 401 | 403 }
> {
  const result = await validateApiKey(req);

  if (!result.ok) {
    return { ok: false, error: result.error, status: 401 };
  }

  if (requiredScope && !hasApiKeyScope(result.data.scopes, requiredScope)) {
    return { ok: false, error: "SCOPE_INSUFFICIENT", status: 403 };
  }

  return result;
}
