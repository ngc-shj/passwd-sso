import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  validateExtensionToken,
  hasScope,
} from "@/lib/extension-token";
import { validateApiKey, hasApiKeyScope } from "@/lib/api-key";
import {
  validateServiceAccountToken,
  hasSaTokenScope,
} from "@/lib/service-account-token";
import { API_KEY_PREFIX, type ApiKeyScope } from "@/lib/constants/api-key";
import { SA_TOKEN_PREFIX, type SaTokenScope } from "@/lib/constants/service-account";
import type { ExtensionTokenScope } from "@/lib/constants";

/** Known Bearer token prefixes — tokens with these prefixes never fall through to extension token validation. */
const KNOWN_PREFIXES = [API_KEY_PREFIX, SA_TOKEN_PREFIX, "scim_"] as const;

/** Auth result types that carry a userId (human-initiated). */
export type UserAuthResult = Extract<AuthResult, { userId: string }>;

/** Type guard for auth results with userId. */
export function hasUserId(auth: AuthResult): auth is UserAuthResult {
  return "userId" in auth;
}

export type AuthResult =
  | { type: "session"; userId: string }
  | { type: "token"; userId: string; scopes: ExtensionTokenScope[] }
  | { type: "api_key"; userId: string; tenantId: string; apiKeyId: string; scopes: ApiKeyScope[] }
  | { type: "service_account"; serviceAccountId: string; tenantId: string; tokenId: string; scopes: SaTokenScope[] };

export type AuthOrTokenResult =
  | AuthResult
  | { type: "scope_insufficient" }
  | null;

/**
 * Authenticate via Auth.js session OR extension token OR API key OR SA token (Bearer).
 *
 * Priority: session > Bearer token (prefix table dispatch) > null
 * - Session-based auth always passes scope checks (full access).
 * - Bearer `api_` prefix → API key validation.
 * - Bearer `sa_` prefix → Service account token validation.
 * - Bearer with other known prefix (e.g. `scim_`) → null (handled by dedicated routes).
 * - Bearer without known prefix → extension token validation.
 * - Returns `{ type: "scope_insufficient" }` when token is valid but lacks scope.
 * - Returns `null` when neither auth method succeeds.
 */
export async function authOrToken(
  req: NextRequest,
  requiredScope?: ExtensionTokenScope | ApiKeyScope | SaTokenScope,
): Promise<AuthOrTokenResult> {
  // Try session first
  const session = await auth();
  if (session?.user?.id) {
    return { type: "session", userId: session.user.id };
  }

  // Check Bearer token — prefix table dispatch
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!bearer) return null;

  // API key path
  if (bearer.startsWith(API_KEY_PREFIX)) {
    const result = await validateApiKey(req);
    if (!result.ok) return null;

    if (requiredScope && !hasApiKeyScope(result.data.scopes, requiredScope as ApiKeyScope)) {
      return { type: "scope_insufficient" };
    }

    return {
      type: "api_key",
      userId: result.data.userId,
      tenantId: result.data.tenantId,
      apiKeyId: result.data.apiKeyId,
      scopes: result.data.scopes,
    };
  }

  // Service account token path
  if (bearer.startsWith(SA_TOKEN_PREFIX)) {
    const result = await validateServiceAccountToken(req);
    if (!result.ok) return null;

    if (requiredScope && !hasSaTokenScope(result.data.scopes, requiredScope as SaTokenScope)) {
      return { type: "scope_insufficient" };
    }

    return {
      type: "service_account",
      serviceAccountId: result.data.serviceAccountId,
      tenantId: result.data.tenantId,
      tokenId: result.data.tokenId,
      scopes: result.data.scopes,
    };
  }

  // Unknown known prefix → reject (do not fall through to extension token)
  if (KNOWN_PREFIXES.some((p) => bearer.startsWith(p))) {
    return null;
  }

  // Extension token path (no known prefix → assume extension token)
  const result = await validateExtensionToken(req);
  if (!result.ok) return null;

  if (requiredScope && !hasScope(result.data.scopes, requiredScope as ExtensionTokenScope)) {
    return { type: "scope_insufficient" };
  }

  return {
    type: "token",
    userId: result.data.userId,
    scopes: result.data.scopes,
  };
}
