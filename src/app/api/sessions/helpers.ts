import type { NextRequest } from "next/server";
import {
  readSessionCookie,
  SESSION_COOKIE_READ,
} from "@/lib/auth/session/session-cookie";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

/**
 * The session token Auth.js resolves from this Cookie header, or null when
 * there is none or the header could be read as more than one session.
 *
 * Reads the raw header, never a `RequestCookies` / `cookies()` store: those
 * keep the LAST occurrence of a name while Auth.js keeps the first, so
 * `name=A; name=B` would have `auth()` authenticate A while step-up and
 * "current session" checks evaluated B.
 */
export function getSessionTokenFromCookieHeader(
  cookieHeader: string | null,
): string | null {
  const read = readSessionCookie(cookieHeader);
  return read.kind === SESSION_COOKIE_READ.TOKEN ? read.token : null;
}

export function getSessionToken(req: NextRequest): string | null {
  return getSessionTokenFromCookieHeader(req.headers.get("cookie"));
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
