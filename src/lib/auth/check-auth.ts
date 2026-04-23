import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { authOrToken, hasUserId, type UserAuthResult } from "@/lib/auth/auth-or-token";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { API_ERROR } from "@/lib/http/api-error-codes";
import type { ExtensionTokenScope } from "@/lib/constants";
import type { ApiKeyScope } from "@/lib/constants/auth/api-key";
import type { McpScope } from "@/lib/constants/auth/mcp";

export interface CheckAuthOptions {
  /** Required scope for token/API key access. Presence enables token-aware auth. */
  scope?: ExtensionTokenScope | ApiKeyScope | McpScope;
  /** Allow token-based auth (Bearer tokens, API keys). Default: true when scope is set, false otherwise. */
  allowTokens?: boolean;
  /** Skip access restriction check for non-session auth. Default: false (always check). */
  skipAccessRestriction?: boolean;
}

type CheckAuthSuccess = { ok: true; auth: UserAuthResult };
type CheckAuthFailure = { ok: false; response: NextResponse };
export type CheckAuthResult = CheckAuthSuccess | CheckAuthFailure;

/**
 * Unified authentication check for API route handlers.
 *
 * Returns `auth` with `userId: string` guaranteed — auth types without a
 * userId (service_account, mcp_token with null userId) are automatically
 * rejected. Callers never need manual type narrowing or casts.
 *
 * Usage:
 *   // Session-only (replaces `auth()` pattern)
 *   const result = await checkAuth(req);
 *   if (!result.ok) return result.response;
 *   const { userId } = result.auth; // string, guaranteed
 *
 *   // Token-aware (replaces `authOrToken()` + `enforceAccessRestriction()`)
 *   const result = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
 *   if (!result.ok) return result.response;
 */
export async function checkAuth(
  req: NextRequest,
  options?: CheckAuthOptions,
): Promise<CheckAuthResult> {
  const scope = options?.scope;
  const allowTokens = options?.allowTokens ?? (scope != null);
  const skipAccessRestriction = options?.skipAccessRestriction ?? false;

  // Invalid combination: scope requires token support
  if (scope != null && options?.allowTokens === false) {
    throw new Error(
      "checkAuth: { scope, allowTokens: false } is invalid — scope requires token support",
    );
  }

  // Dev warning: allowTokens without scope means no scope validation
  if (allowTokens && scope == null && process.env.NODE_ENV === "development") {
    console.warn(
      "checkAuth: allowTokens is true but no scope is set — tokens will be accepted without scope validation",
    );
  }

  if (allowTokens) {
    // Token-aware path: session + extension token + API key + MCP token
    const authResult = await authOrToken(req, scope);

    if (authResult?.type === "scope_insufficient") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT },
          { status: 403 },
        ),
      };
    }

    if (!authResult || !hasUserId(authResult)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: API_ERROR.UNAUTHORIZED },
          { status: 401 },
        ),
      };
    }

    // Enforce access restriction for non-session auth
    if (authResult.type !== "session" && !skipAccessRestriction) {
      const denied = await enforceAccessRestriction(
        req,
        authResult.userId,
        authResult.type === "api_key" || authResult.type === "mcp_token"
          ? authResult.tenantId
          : undefined,
      );
      if (denied) return { ok: false, response: denied };
    }

    return { ok: true, auth: authResult };
  }

  // Session-only path
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: API_ERROR.UNAUTHORIZED },
        { status: 401 },
      ),
    };
  }

  return {
    ok: true,
    auth: { type: "session", userId: session.user.id },
  };
}
