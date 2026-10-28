/**
 * The one reader that turns a Cookie header into "which session is this".
 *
 * Auth.js resolves the session from the raw Cookie header with its vendored
 * parser (`@auth/core/lib/vendored/cookie.js`: first occurrence of a key wins,
 * key and value trimmed of space/tab, value URI-decoded when it holds `%`,
 * quotes kept) feeding `SessionStore`, which joins every cookie whose name
 * STARTS WITH the configured name (JWT chunking: `<name>.0`, `<name>.1`, ...).
 * Any other parser — Next's `RequestCookies` (last occurrence wins, no trim),
 * a hand-rolled split — can be handed a header on which it picks one session
 * while `auth()` authenticates another, and every decision taken on the
 * former (proxy IP restriction, step-up freshness, "current session") then
 * applies to the wrong session.
 *
 * `readSessionCookie` therefore answers with a token only when its reading is
 * the one Auth.js must make, and refuses the rest. The database session
 * strategy never writes chunks, so a legitimate client never sends a prefixed
 * name or an encoded value.
 */

import {
  ALL_KNOWN_SESSION_COOKIE_NAMES,
  configuredSessionCookieName,
} from "@/lib/auth/session/cookie-name";

export type CookiePair = { key: string; value: string };

/**
 * Session tokens are minted by exactly two generators: Auth.js's
 * `generateSessionToken`, set explicitly in `src/auth.ts` to
 * `crypto.randomUUID()` (the same as Auth.js's default in
 * `@auth/core/lib/init.js`, pinned so an upgrade cannot change it), and the
 * passkey sign-in route
 * (`${randomUUID()}${randomBytes(16).toString("hex")}`,
 * `src/app/api/auth/passkey/verify/route.ts`). Both emit lowercase hex and
 * `-` only. A value outside this alphabet is never a real token, and
 * refusing it also refuses every spelling Auth.js would rewrite before use
 * (`%`-encoding, whitespace) or that a different parser would rewrite
 * (quotes).
 */
const SESSION_TOKEN_PATTERN = /^[0-9a-f-]+$/;

export const SESSION_COOKIE_READ = {
  NONE: "none",
  TOKEN: "token",
  AMBIGUOUS: "ambiguous",
} as const;

export type SessionCookieRead =
  | { kind: typeof SESSION_COOKIE_READ.NONE }
  | { kind: typeof SESSION_COOKIE_READ.TOKEN; token: string }
  | { kind: typeof SESSION_COOKIE_READ.AMBIGUOUS };

function isSpaceOrTab(ch: string): boolean {
  return ch === " " || ch === "\t";
}

// String.prototype.trim() also strips CR/LF/NBSP etc., which Auth.js keeps.
function trimSpaceTab(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpaceOrTab(s[start])) start++;
  while (end > start && isSpaceOrTab(s[end - 1])) end--;
  return s.slice(start, end);
}

/**
 * Every `key=value` pair of the header, in order, split the way Auth.js's
 * vendored parser splits it: on `;`, at the first `=`, key and value trimmed
 * of space and tab only. Segments without `=` are skipped. Values are left
 * raw (not decoded) and duplicates are kept — Auth.js keeps the first
 * occurrence of a key, and whether a duplicate matters is the caller's call.
 */
export function parseCookiePairs(header: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const segment of header.split(";")) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    pairs.push({
      key: trimSpaceTab(segment.slice(0, eqIdx)),
      value: trimSpaceTab(segment.slice(eqIdx + 1)),
    });
  }
  return pairs;
}

/**
 * The session token Auth.js resolves from this header, or a refusal.
 *
 * - The configured name repeated: the FIRST occurrence is the one, exactly as
 *   Auth.js's parser keeps it. A browser sends two same-name cookies when
 *   another app on the host sets one at a shorter path (RFC 6265 §5.4 orders
 *   the longer path, ours, first), so refusing duplicates would lock those
 *   users out. Picking the first is safe only because every reader of the
 *   session cookie goes through this function: no reader is left that picks
 *   another one (Next's `RequestCookies` picks the last).
 * - Its first value empty → `none` (`SessionStore` skips empty values).
 * - Any OTHER key that starts with the configured name (a chunk `<name>.0`,
 *   or `<name>X`) → `ambiguous`: `SessionStore` would join it into the token.
 * - The first value outside the token alphabet → `ambiguous`.
 *
 * Callers treat `ambiguous` as "no session", never as a best guess.
 */
export function readSessionCookie(header: string | null): SessionCookieRead {
  if (!header) return { kind: SESSION_COOKIE_READ.NONE };
  const name = configuredSessionCookieName();
  const candidates = parseCookiePairs(header).filter((pair) => pair.key.startsWith(name));
  if (candidates.some((pair) => pair.key !== name && pair.value !== "")) {
    return { kind: SESSION_COOKIE_READ.AMBIGUOUS };
  }
  const first = candidates.find((pair) => pair.key === name);
  if (!first || first.value === "") return { kind: SESSION_COOKIE_READ.NONE };
  return SESSION_TOKEN_PATTERN.test(first.value)
    ? { kind: SESSION_COOKIE_READ.TOKEN, token: first.value }
    : { kind: SESSION_COOKIE_READ.AMBIGUOUS };
}

/**
 * A browser holds at most a handful of session cookies: the configured name in
 * both CHIPS variants, the other known names, and a same-name cookie another
 * app on the host set at a shorter path. Revocation runs a query per token, so
 * the list is bounded well above that.
 */
const MAX_PRESENTED_SESSION_TOKENS = 16;

/**
 * Every distinct session token the header carries under one of `names`, in
 * header order — each duplicate, not only the first occurrence Auth.js reads.
 * For revoking the sessions a browser holds, never for deciding which session
 * a request is (that is readSessionCookie). Only an exact name counts (a
 * chunk `<name>.0` is not a token Auth.js ever wrote), and a value outside
 * the token alphabet is skipped rather than rewritten. `limit` lowers the
 * bound for a caller that needs fewer.
 */
export function presentedSessionTokens(
  header: string | null,
  names: readonly string[],
  limit: number = MAX_PRESENTED_SESSION_TOKENS,
): string[] {
  if (!header) return [];
  const max = Math.min(limit, MAX_PRESENTED_SESSION_TOKENS);
  const tokens = new Set<string>();
  for (const pair of parseCookiePairs(header)) {
    if (tokens.size >= max) break;
    if (names.includes(pair.key) && SESSION_TOKEN_PATTERN.test(pair.value)) {
      tokens.add(pair.value);
    }
  }
  return [...tokens];
}

/**
 * True when the header carries anything that could be a session cookie under
 * any known name, prefix-matched as `SessionStore` matches. For the CSRF gate
 * and the Bearer-bypass decision. An empty value is not counted: `SessionStore`
 * skips it, so it can carry no session, and counting it would send a Bearer
 * client that happens to hold one down the session path to a 401.
 */
export function hasAnySessionCookie(header: string): boolean {
  return parseCookiePairs(header).some(
    (pair) =>
      pair.value !== "" &&
      ALL_KNOWN_SESSION_COOKIE_NAMES.some((name) => pair.key.startsWith(name)),
  );
}
