import { fetchApi } from "@/lib/url-helpers";
import { API_PATH } from "@/lib/constants";

/**
 * Probe whether the current user can recover from a stale-session error via
 * passkey reauthentication (i.e. has at least one credential registered).
 *
 * On any failure the helper returns `true` so a passkey-capable user is not
 * stranded behind a recent-session-only dialog when the probe itself is the
 * problem. The caller falls back to the generic recent-session dialog only
 * when this returns `false`.
 */
export async function canUsePasskeyRecovery(): Promise<boolean> {
  try {
    const res = await fetchApi(API_PATH.USER_AUTH_PROVIDER);
    if (!res.ok) return true;
    const data = (await res.json()) as { canPasskeySignIn?: boolean };
    return data.canPasskeySignIn !== false;
  } catch {
    return true;
  }
}
