import { fetchApi } from "@/lib/url-helpers";
import { API_PATH } from "@/lib/constants";

/**
 * Probe whether the CURRENT SESSION can recover from a stale-session error
 * via an in-place passkey reauth ceremony (C5 member 3) — distinct from
 * `canPasskeySignIn`, which asks whether the account has passkey sign-in at
 * all. Reading the wrong field here would open a ceremony dialog that the
 * server then refuses (C3/C4), since the session's binding is what actually
 * gates the ceremony.
 *
 * On any failure the helper returns `true` so a passkey-capable user is not
 * stranded behind a recent-session-only dialog when the probe itself is the
 * problem. The caller falls back to the generic recent-session dialog only
 * when this returns `false`. The allow check reads `=== true` explicitly
 * (not the inherited `!== false`), so a missing field (older server, cached
 * bundle) reads as "not capable" by decision rather than by accident
 * (finding M18) — the wrong dialog choice ends in `PASSKEY_REAUTH_UNAVAILABLE`
 * and the sign-in-again path, not in a bypass.
 */
export async function canUsePasskeyRecovery(): Promise<boolean> {
  try {
    const res = await fetchApi(API_PATH.USER_AUTH_PROVIDER);
    if (!res.ok) return true;
    const data = (await res.json()) as { canPasskeyReauth?: boolean };
    return data.canPasskeyReauth === true;
  } catch {
    return true;
  }
}
