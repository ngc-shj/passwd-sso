import type { NextRequest } from "next/server";
import { validateApiKeyOnly } from "@/lib/auth/tokens/api-key";
import {
  validateServiceAccountToken,
  hasSaTokenScope,
} from "@/lib/auth/tokens/service-account-token";
import { SA_TOKEN_PREFIX, type SaTokenScope } from "@/lib/constants/auth/service-account";
import type { ApiKeyScope } from "@/lib/constants/auth/api-key";

interface V1AuthSuccess {
  ok: true;
  data: {
    userId: string | null;
    tenantId: string;
    rateLimitKey: string;
    actorType: "api_key" | "service_account";
  };
}

interface V1AuthFailure {
  ok: false;
  error: string;
  status: 401 | 403;
}

export type V1AuthResult = V1AuthSuccess | V1AuthFailure;

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

/**
 * Authenticate v1 API requests via API key (`api_` prefix) or SA token (`sa_` prefix).
 * Session and extension tokens are rejected — v1 is API-only (CSRF prevention).
 *
 * Strategy:
 * 1. Try validateApiKeyOnly — handles the `api_` prefix case (and returns INVALID_TOKEN_TYPE for others).
 * 2. If the token type is wrong (not an api_ token), check for SA token prefix and validate.
 * 3. All other failures (no token, bad token, wrong type) → 401.
 */
export async function validateV1Auth(
  req: NextRequest,
  requiredScope: ApiKeyScope | SaTokenScope,
): Promise<V1AuthResult> {
  // Try API key first (preserves mock contract in tests)
  const apiKeyResult = await validateApiKeyOnly(req, requiredScope as ApiKeyScope);
  if (apiKeyResult.ok) {
    return {
      ok: true,
      data: {
        userId: apiKeyResult.data.userId,
        tenantId: apiKeyResult.data.tenantId,
        rateLimitKey: apiKeyResult.data.apiKeyId,
        actorType: "api_key",
      },
    };
  }

  if (apiKeyResult.error === "SCOPE_INSUFFICIENT") {
    return { ok: false, error: "SCOPE_INSUFFICIENT", status: 403 };
  }

  // If error is not INVALID_TOKEN_TYPE, token was recognized as an api_ key but was invalid
  if (apiKeyResult.error !== "INVALID_TOKEN_TYPE") {
    return { ok: false, error: apiKeyResult.error, status: 401 };
  }

  // INVALID_TOKEN_TYPE: token is not an api_ key — check if it's an SA token
  const bearer = extractBearer(req);
  if (!bearer || !bearer.startsWith(SA_TOKEN_PREFIX)) {
    return { ok: false, error: "UNAUTHORIZED", status: 401 };
  }

  const saResult = await validateServiceAccountToken(req);
  if (!saResult.ok) return { ok: false, error: saResult.error, status: 401 };

  if (!hasSaTokenScope(saResult.data.scopes, requiredScope as SaTokenScope)) {
    return { ok: false, error: "SCOPE_INSUFFICIENT", status: 403 };
  }

  return {
    ok: true,
    data: {
      userId: null,
      tenantId: saResult.data.tenantId,
      rateLimitKey: saResult.data.serviceAccountId,
      actorType: "service_account",
    },
  };
}
