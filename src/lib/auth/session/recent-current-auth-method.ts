import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { unauthorized } from "@/lib/http/api-response";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  requireRecentSession,
  type RequireRecentSessionOptions,
} from "@/lib/auth/session/step-up";
import { requireRecentPasskeyVerification } from "@/lib/auth/webauthn/recent-passkey-verification";

/**
 * Route-level step-up chooser.
 *
 * WebAuthn-established sessions use recent passkey verification; other
 * session types stay on the generic recent-session gate.
 *
 * Bootstrap-tenant invariant: a `provider === "webauthn"` session can only
 * exist for bootstrap-tenant users because `src/app/api/auth/passkey/verify/route.ts`
 * rejects non-bootstrap users before creating the session row. This means
 * routing the webauthn branch to passkey reauth is always recoverable in-app
 * (the user has at least one credential by construction).
 * `provider === null` (legacy sessions predating the provenance migration)
 * falls through to the generic recent-session gate.
 */
export async function requireRecentCurrentAuthMethod(
  req: NextRequest,
  options: RequireRecentSessionOptions = {},
) {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const sessionRow = await withBypassRls(
    prisma,
    async (tx) =>
      tx.session.findUnique({
        where: { sessionToken },
        select: { provider: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!sessionRow) {
    return unauthorized();
  }

  if (sessionRow.provider === "webauthn") {
    return requireRecentPasskeyVerification(req, options);
  }

  return requireRecentSession(req, options);
}
