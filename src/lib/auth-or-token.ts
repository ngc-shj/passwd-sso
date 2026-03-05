import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  validateExtensionToken,
  hasScope,
} from "@/lib/extension-token";
import { validateApiKey, hasApiKeyScope } from "@/lib/api-key";
import { API_KEY_PREFIX, type ApiKeyScope } from "@/lib/constants/api-key";
import type { ExtensionTokenScope } from "@/lib/constants";

export type AuthResult =
  | { type: "session"; userId: string }
  | { type: "token"; userId: string; scopes: ExtensionTokenScope[] }
  | { type: "api_key"; userId: string; tenantId: string; apiKeyId: string; scopes: ApiKeyScope[] };

export type AuthOrTokenResult =
  | AuthResult
  | { type: "scope_insufficient" }
  | null;

/**
 * Authenticate via Auth.js session OR extension token OR API key (Bearer).
 *
 * Priority: session > Bearer token (prefix dispatch) > null
 * - Session-based auth always passes scope checks (full access).
 * - Bearer `api_` prefix → API key validation.
 * - Bearer without `api_` prefix → extension token validation.
 * - Returns `{ type: "scope_insufficient" }` when token is valid but lacks scope.
 * - Returns `null` when neither auth method succeeds.
 */
export async function authOrToken(
  req: NextRequest,
  requiredScope?: ExtensionTokenScope | ApiKeyScope,
): Promise<AuthOrTokenResult> {
  // Try session first
  const session = await auth();
  if (session?.user?.id) {
    return { type: "session", userId: session.user.id };
  }

  // Check Bearer token — dispatch by prefix
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (bearer?.startsWith(API_KEY_PREFIX)) {
    // API key path
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

  // Extension token path
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
