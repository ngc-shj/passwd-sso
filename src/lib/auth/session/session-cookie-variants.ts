/**
 * Raw Set-Cookie lines for the two CHIPS variants of the session cookie.
 *
 * A CHIPS browser stores a partitioned and an unpartitioned cookie of the
 * same name side by side and sends both, older first; which of them a browser
 * holds depends on every value COOKIE_PARTITIONED has had. A response that
 * writes or deletes the session cookie therefore has to address the other
 * variant too. Set-Cookie lines apply in order, so deleting the other variant
 * BEFORE the line that writes the session cookie is safe in every browser
 * class: under CHIPS it removes the other variant, without CHIPS it deletes
 * the same cookie the next line sets again.
 *
 * Next's `ResponseCookies` keeps one entry per name and re-serializes every
 * line on each write, so two lines for one name cannot go through it: both
 * are raw lines, appended after the response's last `response.cookies` write.
 */

import { NextResponse } from "next/server";
import {
  configuredSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "@/lib/auth/session/cookie-name";

/**
 * A raw Set-Cookie line deleting `name` at `${basePath}/` in one CHIPS
 * variant. The attributes mirror the set-time ones: the `__Secure-` /
 * `__Host-` prefixes require `Secure` on the deletion too, or the browser
 * ignores it.
 */
export function sessionCookieDeletionLine(
  name: string,
  basePath: string,
  partitioned: boolean,
): string {
  const response = new NextResponse(null);
  response.cookies.delete({
    name,
    path: `${basePath}/`,
    secure: isSecureCookieFromAuthUrl(),
    httpOnly: true,
    sameSite: "lax",
    ...(partitioned ? { partitioned: true } : {}),
  });
  return response.headers.getSetCookie()[0];
}

function setCookieLineName(line: string): string {
  const eqIdx = line.indexOf("=");
  return eqIdx === -1 ? "" : line.slice(0, eqIdx).trim();
}

function setCookieLineIsPartitioned(line: string): boolean {
  return line
    .split(";")
    .slice(1)
    .some((attribute) => attribute.trim().toLowerCase() === "partitioned");
}

/**
 * `lines` — a response's Set-Cookie lines, in order — with the configured
 * session cookie's other CHIPS variant deleted immediately before the first
 * line that writes or deletes that cookie. Unchanged when no line names it
 * (the response did not sign anyone in or out) or when the deployment is not
 * Secure (Partitioned requires Secure, so there is no other variant).
 */
export function deleteOtherSessionCookieVariantFirst(
  lines: readonly string[],
  basePath: string,
): string[] {
  if (!isSecureCookieFromAuthUrl()) return [...lines];
  const name = configuredSessionCookieName();
  const index = lines.findIndex((line) => setCookieLineName(line) === name);
  if (index === -1) return [...lines];
  const otherVariant = sessionCookieDeletionLine(
    name,
    basePath,
    !setCookieLineIsPartitioned(lines[index]),
  );
  return [...lines.slice(0, index), otherVariant, ...lines.slice(index)];
}
