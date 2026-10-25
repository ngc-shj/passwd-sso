import type { NextRequest } from "next/server";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

/**
 * Minimal structural view of a cookie store — satisfied by both
 * `NextRequest.cookies` (route handlers) and the `cookies()` store from
 * `next/headers` (server components). Keeps the session-cookie NAME
 * resolution on the single SSoT (`configuredSessionCookieName`) for every reader.
 */
type CookieReader = {
  get(name: string): { value: string } | undefined;
};

export function getSessionTokenFromCookieStore(
  store: CookieReader,
): string | null {
  return store.get(configuredSessionCookieName())?.value ?? null;
}

export function getSessionToken(req: NextRequest): string | null {
  return getSessionTokenFromCookieStore(req.cookies);
}

/**
 * H4: the DB stores the digest of the session token, never the raw cookie value.
 * Any DB lookup / comparison against `Session.sessionToken` must use this digest,
 * NOT the raw token from getSessionToken. Returns null when no cookie is present.
 */
export function getSessionTokenDigest(req: NextRequest): string | null {
  const raw = getSessionToken(req);
  return raw == null ? null : hashSessionToken(raw);
}

export function getSessionTokenDigestFromCookieStore(
  store: CookieReader,
): string | null {
  const raw = getSessionTokenFromCookieStore(store);
  return raw == null ? null : hashSessionToken(raw);
}
