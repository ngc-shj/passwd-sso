import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import {
  validateExtensionToken,
  hasScope,
} from "@/lib/extension-token";
import type { ExtensionTokenScope } from "@/lib/constants";

export type AuthResult =
  | { type: "session"; userId: string }
  | { type: "token"; userId: string; scopes: ExtensionTokenScope[] };

export type AuthOrTokenResult =
  | AuthResult
  | { type: "scope_insufficient" }
  | null;

/**
 * Authenticate via Auth.js session OR extension token (Bearer).
 *
 * - Session-based auth always passes scope checks (full access).
 * - Token-based auth checks `requiredScope` if provided.
 * - Returns `{ type: "scope_insufficient" }` when token is valid but lacks scope.
 * - Returns `null` when neither auth method succeeds.
 */
export async function authOrToken(
  req: NextRequest,
  requiredScope?: ExtensionTokenScope,
): Promise<AuthOrTokenResult> {
  // Try session first
  const session = await auth();
  if (session?.user?.id) {
    return { type: "session", userId: session.user.id };
  }

  // Fall back to extension token
  const result = await validateExtensionToken(req);
  if (!result.ok) return null;

  if (requiredScope && !hasScope(result.data.scopes, requiredScope)) {
    return { type: "scope_insufficient" };
  }

  return {
    type: "token",
    userId: result.data.userId,
    scopes: result.data.scopes,
  };
}
