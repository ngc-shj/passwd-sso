import { clientLogWarn, CLIENT_LOG_EVENT, opaque } from "@/lib/logger/client";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { getLocaleFromPathname, stripLocalePrefix } from "@/i18n/locale-utils";
import { PASSKEY_PAGE_PATH } from "@/lib/constants/auth/page-path";
import { EXPECTED_USER_HEADER } from "@/lib/constants/auth/expected-user";
import { MS_PER_SECOND } from "@/lib/constants/time";

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Derive basePath from a URL: pathname (trailing slash stripped), with a
 * fallback to `process.env.NEXT_PUBLIC_BASE_PATH` for deployments that put
 * the sub-path in the env var instead of AUTH_URL.
 *
 * Reads process.env at call time so tests can override via vi.stubEnv.
 * Used by canonicalHtu and canonicalHtuClient — the only consumers in the
 * codebase today. Test mocks of `@/lib/url-helpers` MUST include this
 * export (spread via `vi.importActual` is the preferred pattern).
 *
 * @param url Parsed URL (e.g. `new URL(AUTH_URL)` or `new URL(serverUrl)`).
 */
export function resolveBasePath(url: URL): string {
  let basePath = url.pathname;
  if (basePath.endsWith("/")) basePath = basePath.slice(0, -1);
  if (!basePath) {
    const envBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    if (envBasePath) basePath = envBasePath;
  }
  return basePath;
}


/**
 * Resolve the canonical app origin from environment.
 * Priority: APP_URL > AUTH_URL.
 *
 * Returns the raw env value (may contain trailing slash or path).
 * Callers that need only the origin should use `new URL(url).origin`.
 *
 * Server-side only — reads process.env at call time for testability.
 */
export function getAppOrigin(): string | undefined {
  return process.env.APP_URL || process.env.AUTH_URL || undefined;
}

/**
 * Whether the app is served over HTTPS.
 * Determined by the AUTH_URL scheme — not NODE_ENV, which can be
 * "production" even on http://localhost via `npm start`.
 */
export const isHttps = (process.env.AUTH_URL ?? "http://localhost:3000").startsWith("https://");

/**
 * Prepend basePath to a path (for fetch, window.location.href, etc.).
 * Client-side only — do NOT use inside server-side route handlers.
 */
export function withBasePath(path: string): string {
  if (process.env.NODE_ENV !== "production" && path && !path.startsWith("/")) {
    // The path itself is never logged: it is caller-supplied and can carry a
    // token in its query string. The first segment is enough to locate the
    // offending call, and it is taken before any "?" so no query survives.
    clientLogWarn(CLIENT_LOG_EVENT.BASE_PATH_MALFORMED, {
      firstSegment: opaque(path.split(/[?#/]/)[0], 32),
    });
  }
  return `${BASE_PATH}${path}`;
}

/**
 * The current document's app path: `window.location` without basePath, with
 * its query string. Feeding it back to `hardNavigate` reloads the same page.
 * Client-side only.
 */
export function currentAppPath(): string {
  const { pathname, search } = window.location;
  const appPathname =
    BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))
      ? pathname.slice(BASE_PATH.length) || "/"
      : pathname;
  return `${appPathname}${search}`;
}

// ─── PASSKEY_REQUIRED reaction ─────────────────────────────────
// The proxy refuses a passkey-blocked session's API calls with 403
// PASSKEY_REQUIRED. A dashboard or admin tab rendered before the block took
// effect (or a soft navigation that kept the old layout) would otherwise keep
// failing call by call, so fetchApi reloads it once onto the passkey page,
// where the dashboard layout renders the minimal registration screen.
//
// The exclusion is keyed on whether that screen is mounted, not on the
// pathname: a stale shell can sit on the passkey URL itself and must still be
// reloaded once. The once-per-load latch is what stops a loop if the reload
// lands on something that issues another gated call.

const PASSKEY_REACTION_SCOPES = ["/dashboard", "/admin"] as const;

let passkeyRequiredScreenMounted = false;
let passkeyRedirectLatched = false;

/** Set by `PasskeyRequiredScreen` on mount, cleared on unmount. */
export function setPasskeyRequiredScreenMounted(mounted: boolean): void {
  passkeyRequiredScreenMounted = mounted;
}

/** @internal Test-only — clears the mounted flag and the once-per-load latch. */
export function _resetPasskeyRequiredReactionForTests(): void {
  passkeyRequiredScreenMounted = false;
  passkeyRedirectLatched = false;
}

async function reactToPasskeyRequired(res: Response): Promise<void> {
  // Never throws: the caller gets its response back whatever happens here,
  // including a stubbed Response without clone() or an unreadable body.
  try {
    if (res.status !== 403) return;
    if (passkeyRequiredScreenMounted || passkeyRedirectLatched) return;

    const appPath = stripLocalePrefix(currentAppPath().split("?")[0]);
    const inScope = PASSKEY_REACTION_SCOPES.some(
      (scope) => appPath === scope || appPath.startsWith(`${scope}/`),
    );
    if (!inScope) return;

    if ((await readApiErrorBody(res.clone()))?.error !== API_ERROR.PASSKEY_REQUIRED) return;

    passkeyRedirectLatched = true;
    const locale = getLocaleFromPathname(currentAppPath());
    hardNavigate(`/${locale}${PASSKEY_PAGE_PATH}`);
  } catch {
    // Best-effort UX reaction; the 403 itself still reaches the caller.
  }
}

// ─── Expected-user binding ─────────────────────────────────────
// The session cookie is shared by every tab, so a page rendered for user A
// sends B's cookie once B signs in elsewhere, and its timers and in-flight
// flows (holding A's keys) would act as B. fetchApi names the user this page
// is bound to; the proxy (src/lib/proxy/expected-user-gate.ts) refuses a
// request whose cookie is another user's session with 409 SESSION_CHANGED.
//
// Bound once per page load, by ExpectedUserSync, to the first user useSession
// names. Unset until then: no request before that can carry anything bound to
// a user. Never re-pointed and never cleared — a page that saw its session end
// still holds what it held. When useSession later names another user, the
// binding stays on the first one and the page reloads: no fetchApi request
// this document sends once bound is served under another user's session.
// Requests that do not go through fetchApi carry no header and are outside
// the binding — next-auth's own calls among them (signIn, signOut, useSession's
// session fetch), and any plain fetch or form post.

let expectedUserId: string | null = null;

// A session-changed reload in flight. While it is, further 409s do not start
// another one, and the app's beforeunload guards stand down (see
// useBeforeUnloadGuard): the page belongs to a user whose session is gone, so
// nothing it would keep could be saved. Anything else can still cancel the
// navigation (a stop, a handler outside the app), so the hold expires: after
// SESSION_CHANGED_RELOAD_PENDING_MS the next 409 reloads again. A navigation
// started then replaces any still in flight, so at most one is pending.
export const SESSION_CHANGED_RELOAD_PENDING_MS = 10 * MS_PER_SECOND;
let sessionChangedReloadStartedAt: number | null = null;

/** Whether a session-changed reload is in flight; the app's guards must not hold it. */
export function isSessionChangedReloadPending(): boolean {
  return (
    sessionChangedReloadStartedAt !== null &&
    Date.now() - sessionChangedReloadStartedAt < SESSION_CHANGED_RELOAD_PENDING_MS
  );
}

function reloadForSessionChange(): void {
  if (isSessionChangedReloadPending()) return;
  sessionChangedReloadStartedAt = Date.now();
  hardNavigate(currentAppPath());
}

/**
 * Called by ExpectedUserSync whenever useSession names a user. Binds the page
 * to the first one; a different one reloads the page instead of re-binding.
 */
export function setExpectedUser(userId: string): void {
  if (expectedUserId === null) {
    expectedUserId = userId;
    return;
  }
  if (userId !== expectedUserId) reloadForSessionChange();
}

/** @internal Test-only — unsets the expected user and the pending reload. */
export function _resetExpectedUserForTests(): void {
  expectedUserId = null;
  sessionChangedReloadStartedAt = null;
}

/**
 * Thrown by fetchApi when the proxy refused the request because the session
 * is no longer the page's user. Never a business refusal: a caller must not
 * read it as a wrong passphrase, a denied action, or a missing record.
 */
export class SessionChangedError extends Error {
  constructor() {
    super("The session changed since this page was loaded");
    this.name = "SessionChangedError";
  }
}

function withExpectedUser(url: string, init: RequestInit | undefined): RequestInit | undefined {
  if (expectedUserId === null) return init;
  // Same-origin only: the header names a user, and a cross-origin target is
  // none of the proxy's business.
  if (new URL(url, window.location.origin).origin !== window.location.origin) return init;
  const headers = new Headers(init?.headers);
  headers.set(EXPECTED_USER_HEADER, expectedUserId);
  return { ...init, headers };
}

async function isSessionChanged(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  try {
    return (await readApiErrorBody(res.clone()))?.error === API_ERROR.SESSION_CHANGED;
  } catch {
    return false;
  }
}

/**
 * Fetch wrapper that automatically prepends basePath.
 * Client-side only — do NOT use inside server-side route handlers.
 *
 * Once the page knows its user, every same-origin request sent through here
 * names it (see the binding above). A 409 SESSION_CHANGED rejects with SessionChangedError —
 * so no caller can mistake it for its own business refusal, and a multi-step
 * flow stops at the first refused step — and reloads the page, rebuilding it
 * for whoever the session now belongs to. Other proxy refusals (a 503 when the
 * session could not be read) are returned like any response and do not reload.
 *
 * A 403 PASSKEY_REQUIRED on a dashboard or admin page additionally reloads the
 * tab onto the passkey page (see the reaction above). The response is returned
 * unchanged.
 */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") {
    throw new Error("fetchApi is client-only. Use absolute URLs on the server.");
  }
  const url = withBasePath(path);
  const boundInit = withExpectedUser(url, init);
  const pending = boundInit !== undefined ? fetch(url, boundInit) : fetch(url);
  return pending.then(async (res) => {
    if (await isSessionChanged(res)) {
      reloadForSessionChange();
      throw new SessionChangedError();
    }
    await reactToPasskeyRequired(res);
    return res;
  });
}

/**
 * Navigate by replacing the document, not by a client-side route change.
 *
 * The full reload is the point at every call site: after a vault reset or
 * recovery the whole React tree — including the in-memory encryption key held
 * by VaultProvider — must be rebuilt from scratch, and a download endpoint is
 * not a Next page at all. `useRouter().push()` would keep the old heap alive,
 * so this is the one place allowed to assign `window.location.href`.
 *
 * Being that one place is also why it refuses to leave the current origin: a
 * string reaching this function IS a navigation, so `//evil.example` (which
 * `withBasePath` leaves protocol-relative whenever BASE_PATH is empty) or a
 * `javascript:` URL would be an open redirect here rather than a bug at the
 * call site. Callers pass literal routes today; the guard is what keeps that
 * from being load-bearing. The refusal names only the origin — a caller-supplied
 * path can carry a token in its query string.
 *
 * Client-side only.
 */
export function hardNavigate(path: string): void {
  const target = new URL(withBasePath(path), window.location.origin);
  if (target.origin !== window.location.origin) {
    throw new Error(`hardNavigate: refusing to navigate to origin ${target.origin}`);
  }
  window.location.href = target.toString();
}

/**
 * Build a full URL (origin + basePath + path) for clipboard / sharing.
 * Browser-only (references window.location.origin).
 */
export function appUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}${path}`;
}

/**
 * Build a full URL (APP_URL + basePath + path) for server-side use
 * (e.g. email links). Uses APP_URL/AUTH_URL env vars instead of window.
 */
export function serverAppUrl(path: string): string {
  const origin = getAppOrigin() ?? "";
  return `${origin}${BASE_PATH}${path}`;
}
