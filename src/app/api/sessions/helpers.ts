import type { NextRequest } from "next/server";
import {
  getSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "@/lib/auth/session/cookie-name";

/**
 * Minimal structural view of a cookie store — satisfied by both
 * `NextRequest.cookies` (route handlers) and the `cookies()` store from
 * `next/headers` (server components). Keeps the session-cookie NAME
 * resolution on the single SSoT (`getSessionCookieName`) for every reader.
 */
type CookieReader = {
  get(name: string): { value: string } | undefined;
};

export function getSessionTokenFromCookieStore(
  store: CookieReader,
): string | null {
  const name = getSessionCookieName({
    useSecureCookies: isSecureCookieFromAuthUrl(),
    basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  });
  return store.get(name)?.value ?? null;
}

export function getSessionToken(req: NextRequest): string | null {
  return getSessionTokenFromCookieStore(req.cookies);
}
