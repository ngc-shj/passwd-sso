import { clientLogWarn, CLIENT_LOG_EVENT, opaque } from "@/lib/logger/client";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { getLocaleFromPathname, stripLocalePrefix } from "@/i18n/locale-utils";

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

const PASSKEY_PAGE_PATH = "/dashboard/settings/auth/passkey";
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

    const body: unknown = await res.clone().json();
    if (
      typeof body !== "object" ||
      body === null ||
      (body as { error?: unknown }).error !== API_ERROR.PASSKEY_REQUIRED
    ) {
      return;
    }

    passkeyRedirectLatched = true;
    const locale = getLocaleFromPathname(currentAppPath());
    hardNavigate(`/${locale}${PASSKEY_PAGE_PATH}`);
  } catch {
    // Best-effort UX reaction; the 403 itself still reaches the caller.
  }
}

/**
 * Fetch wrapper that automatically prepends basePath.
 * Client-side only — do NOT use inside server-side route handlers.
 *
 * A 403 PASSKEY_REQUIRED on a dashboard or admin page additionally reloads the
 * tab onto the passkey page (see the reaction above). The response is returned
 * unchanged either way.
 */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") {
    throw new Error("fetchApi is client-only. Use absolute URLs on the server.");
  }
  const url = withBasePath(path);
  const pending = init !== undefined ? fetch(url, init) : fetch(url);
  return pending.then(async (res) => {
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
