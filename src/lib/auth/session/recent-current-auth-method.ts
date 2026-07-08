import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  STEP_UP_WINDOW_MS,
  type RequireRecentSessionOptions,
} from "@/lib/auth/session/step-up";
import { PASSKEY_VERIFICATION_WINDOW_MS } from "@/lib/auth/webauthn/recent-passkey-verification";

export type StepUpFreshness = "fresh" | "stale" | "invalid";

/**
 * Provider-aware step-up freshness core, shared by the route-level gate
 * (`requireRecentCurrentAuthMethod`) and the sign-in page's reauth-panel
 * branch. Both entry points MUST evaluate through this single function —
 * any divergence between what the page deems "fresh" and what the gate
 * accepts re-opens the stale-session redirect loop this exists to close.
 *
 * WebAuthn-established sessions are judged on `passkeyVerifiedAt` (refreshed
 * by the passkey reauth ceremony without replacing the session); every other
 * provider is judged on `createdAt` (refreshed only by a fresh sign-in).
 *
 * Bootstrap-tenant invariant: a `provider === "webauthn"` session can only
 * exist for bootstrap-tenant users because `src/app/api/auth/passkey/verify/route.ts`
 * rejects non-bootstrap users before creating the session row. The user had
 * at least one credential at session creation; credentials may have been
 * deleted since, which is why reauth UIs must always offer a sign-in-again
 * fallback alongside the ceremony.
 * `provider === null` (legacy sessions predating the provenance migration)
 * falls through to the generic recent-session gate.
 */
export async function evaluateStepUpFreshness(
  sessionToken: string,
  options: RequireRecentSessionOptions = {},
): Promise<StepUpFreshness> {
  const sessionRow = await withBypassRls(
    prisma,
    async (tx) =>
      tx.session.findUnique({
        where: { sessionToken },
        select: { provider: true, createdAt: true, passkeyVerifiedAt: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!sessionRow) return "invalid";

  if (sessionRow.provider === "webauthn") {
    // A live webauthn session with no verification timestamp is stale (needs
    // a ceremony), NOT invalid — matches the pre-refactor 403 semantics.
    if (!sessionRow.passkeyVerifiedAt) return "stale";
    const maxAgeMs = options.maxAgeMs ?? PASSKEY_VERIFICATION_WINDOW_MS;
    return Date.now() - sessionRow.passkeyVerifiedAt.getTime() > maxAgeMs
      ? "stale"
      : "fresh";
  }

  const maxAgeMs = options.maxAgeMs ?? STEP_UP_WINDOW_MS;
  return Date.now() - sessionRow.createdAt.getTime() > maxAgeMs
    ? "stale"
    : "fresh";
}

/**
 * Whether a stale session can be recovered with an in-place passkey ceremony
 * (webauthn-established session AND the user still has at least one
 * registered credential — credentials may have been deleted after sign-in).
 * Non-recoverable sessions fall back to sign-out + fresh sign-in.
 */
export async function canRecoverSessionWithPasskey(
  sessionToken: string,
  userId: string,
): Promise<boolean> {
  return withBypassRls(
    prisma,
    async (tx) => {
      const row = await tx.session.findUnique({
        where: { sessionToken },
        select: { provider: true, userId: true },
      });
      // Bind the two parameters: a caller passing a userId that does not own
      // this session must not learn whether that user has credentials.
      if (row?.provider !== "webauthn" || row.userId !== userId) return false;
      const credentialCount = await tx.webAuthnCredential.count({
        where: { userId },
      });
      return credentialCount > 0;
    },
    BYPASS_PURPOSE.AUTH_FLOW,
  );
}

/**
 * Route-level step-up gate. Thin wrapper over `evaluateStepUpFreshness`
 * preserving the pre-refactor external contract: missing token / missing
 * session row → 401; stale → 403 with the caller-supplied `errorCode`
 * (default `SESSION_STEP_UP_REQUIRED`); fresh → null.
 */
export async function requireRecentCurrentAuthMethod(
  req: NextRequest,
  options: RequireRecentSessionOptions = {},
) {
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const verdict = await evaluateStepUpFreshness(sessionToken, options);
  if (verdict === "invalid") {
    return unauthorized();
  }
  if (verdict === "stale") {
    return errorResponse(
      options.errorCode ?? API_ERROR.SESSION_STEP_UP_REQUIRED,
      403,
    );
  }
  return null;
}
