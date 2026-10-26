/**
 * Session fixtures for proxy tests (api-route, page-route, the proxy
 * orchestrator). Every builder carries all four passkey fields: a response
 * missing one is substituted with the degraded fail-closed bundle, so a
 * partial fixture tests the outage path, not the one it names.
 */
import type { SessionInfo } from "@/lib/auth/session/session-cache";
import { API_PATH } from "@/lib/constants";

export type PasskeyFields = Pick<
  SessionInfo,
  "hasPasskey" | "requirePasskey" | "requirePasskeyEnabledAt" | "passkeyGracePeriodDays"
>;

/** Requirement off: never blocked. */
export const PASSKEY_ALLOWED: PasskeyFields = {
  hasPasskey: false,
  requirePasskey: false,
  requirePasskeyEnabledAt: null,
  passkeyGracePeriodDays: null,
};

/** Requirement on with no grace period and no passkey: blocked now. */
export const PASSKEY_BLOCKED: PasskeyFields = {
  hasPasskey: false,
  requirePasskey: true,
  requirePasskeyEnabledAt: "2026-01-01T00:00:00.000Z",
  passkeyGracePeriodDays: null,
};

/** A `/api/auth/session` response body for a signed-in user. */
export function sessionResponseBody(
  userId: string,
  passkey: PasskeyFields = PASSKEY_ALLOWED,
  extra: Record<string, unknown> = {},
) {
  return {
    user: { id: userId, ...passkey, ...extra },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

/** A full positive cache entry, the shape SessionInfoSchema accepts. */
export function cachedSessionInfo(
  userId: string,
  tenantId: string,
  passkey: PasskeyFields = PASSKEY_ALLOWED,
  passkeyStateDegraded = false,
): SessionInfo {
  return { valid: true, userId, tenantId, ...passkey, passkeyStateDegraded };
}

type FetchRoute = () => Response;

/**
 * A fetch implementation that dispatches on the request pathname and builds a
 * fresh Response per call (a shared Response's body can be read only once).
 * An unrouted pathname is a test bug and throws.
 */
export function dispatchFetch(routes: Record<string, FetchRoute>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const route = routes[url.pathname];
    if (!route) throw new Error(`unrouted fetch in test: ${url.pathname}`);
    return route();
  };
}

/** The session read answers `body` as JSON with status 200. */
export function sessionRoute(body: unknown): Record<string, FetchRoute> {
  return {
    [API_PATH.AUTH_SESSION]: () => new Response(JSON.stringify(body), { status: 200 }),
  };
}

/** The calls a fetch spy received for the given pathname. */
export function fetchCallsTo(
  spy: { mock: { calls: unknown[][] } },
  pathname: string,
): unknown[][] {
  return spy.mock.calls.filter(([input]) => {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw).pathname === pathname;
  });
}
