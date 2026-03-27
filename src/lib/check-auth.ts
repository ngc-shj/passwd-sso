import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { authOrToken, type AuthResult } from "@/lib/auth-or-token";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { API_ERROR } from "@/lib/api-error-codes";
import type { ExtensionTokenScope } from "@/lib/constants";
import type { ApiKeyScope } from "@/lib/constants/api-key";

export interface CheckAuthOptions {
  /** Required scope for token/API key access. Presence enables token-aware auth. */
  scope?: ExtensionTokenScope | ApiKeyScope;
  /** Allow token-based auth (Bearer tokens, API keys). Default: true when scope is set, false otherwise. */
  allowTokens?: boolean;
  /** Skip access restriction check for non-session auth. Default: false (always check). */
  skipAccessRestriction?: boolean;
}

type CheckAuthSuccess = { ok: true; auth: AuthResult };
type CheckAuthFailure = { ok: false; response: NextResponse };
export type CheckAuthResult = CheckAuthSuccess | CheckAuthFailure;

/**
 * Unified authentication check for API route handlers.
 *
 * Replaces the pattern of calling `authOrToken()` + manual `enforceAccessRestriction()`
 * or `auth()` directly with a single function that handles auth, scope validation,
 * and access restriction.
 *
 * Usage:
 *   // Session-only (replaces `auth()` pattern)
 *   const result = await checkAuth(req);
 *   if (!result.ok) return result.response;
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
    // Token-aware path: session + extension token + API key
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

    if (!authResult) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: API_ERROR.UNAUTHORIZED },
          { status: 401 },
        ),
      };
    }

    // Enforce access restriction for non-session auth
    // SA tokens skip enforceAccessRestriction — it expects userId (FK to users table),
    // passing serviceAccountId would cause FK violation in the audit log write path.
    if (authResult.type !== "session" && authResult.type !== "service_account" && !skipAccessRestriction) {
      {
        const denied = await enforceAccessRestriction(
          req,
          authResult.userId,
          authResult.type === "api_key" ? authResult.tenantId : undefined,
        );
        if (denied) return { ok: false, response: denied };
      }
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
