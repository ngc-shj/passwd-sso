/**
 * Per-signature server authorization for the SSH agent.
 *
 * Before each signature, the agent POSTs to /api/vault/ssh/sign-authorize to
 * authorize the operation and emit an audit event server-side. The result is
 * never cached — one authorize call per signature ensures immediate revocation
 * and a complete audit trail.
 *
 * Threat-model note: this is an honest-agent audit/revocation control. A
 * compromised agent process that already holds the decrypted private key can
 * always sign locally; per-sign authorize cannot prevent that. The value is
 * audit completeness and immediate policy enforcement for an honest agent.
 */

import { apiRequest } from "./api-client.js";
import type { SessionBinding } from "./ssh-session-bind.js";
import * as output from "./output.js";

// One-time hint guard: print "re-run `passwd-sso login`" at most once per run.
let scopeHintEmitted = false;

/**
 * Authorize a single SSH signing operation against the server.
 *
 * Returns true only on HTTP 200 with `authorized === true`.
 * Any other status, network error, or malformed response → false (fail-closed).
 */
export async function authorizeSign(args: {
  keyId: string;
  fingerprint: string;
  binding: SessionBinding | null;
}): Promise<boolean> {
  const { keyId, fingerprint, binding } = args;

  try {
    const body: {
      keyId: string;
      fingerprint: string;
      host?: { hostKeyFingerprint: string; forwarded: boolean };
    } = { keyId, fingerprint };

    if (binding) {
      body.host = {
        hostKeyFingerprint: binding.hostKeyFingerprint,
        forwarded: binding.forwarded,
      };
    }

    const res = await apiRequest<{ authorized: boolean; reason?: string }>(
      "/api/vault/ssh/sign-authorize",
      { method: "POST", body },
    );

    if (res.ok && res.status === 200 && res.data.authorized === true) {
      return true;
    }

    // On scope-deny (401/403 with reason "unauthorized"), print a one-time hint.
    if ((res.status === 401 || res.status === 403) && res.data.reason === "unauthorized") {
      if (!scopeHintEmitted) {
        scopeHintEmitted = true;
        output.warn(
          "Re-run `passwd-sso login` to grant SSH signing (ssh:sign scope).",
        );
      }
    }

    return false;
  } catch (err) {
    output.warn(
      `SSH sign authorize failed: ${err instanceof Error ? err.message : "network error"}`,
    );
    return false;
  }
}

/**
 * Reset the one-time scope hint guard.
 * Exposed for testing only — do not call from production code.
 *
 * @internal
 */
export function _resetScopeHintForTest(): void {
  scopeHintEmitted = false;
}
