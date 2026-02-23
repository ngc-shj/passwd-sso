import type { NextRequest } from "next/server";

/**
 * Determine whether Auth.js uses the __Secure- cookie prefix.
 * Auth.js decides this based on `url.protocol === "https:"` where
 * url comes from AUTH_URL (or NEXTAUTH_URL). We mirror that logic
 * so it works correctly even in dev with AUTH_URL=https://localhost.
 */
function isSecureCookie(): boolean {
  const authUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL || "";
  try {
    return new URL(authUrl).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

export function getSessionToken(req: NextRequest): string | null {
  return isSecureCookie()
    ? req.cookies.get("__Secure-authjs.session-token")?.value ?? null
    : req.cookies.get("authjs.session-token")?.value ?? null;
}
