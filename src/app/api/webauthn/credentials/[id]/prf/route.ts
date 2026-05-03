import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized, errorResponse, forbidden, notFound } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { verifyAuthenticationAssertion } from "@/lib/auth/webauthn/webauthn-server";
import {
  hexIv,
  hexAuthTag,
  PRF_ENCRYPTED_KEY_MAX_LENGTH,
} from "@/lib/validations/common";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const rebootstrapSchema = z.object({
  // WebAuthn assertion proving the caller currently holds the authenticator.
  // Must verify against the dedicated `webauthn:challenge:prf-rebootstrap:${userId}`
  // Redis key. Plain `unknown` here — the helper consumes it as
  // AuthenticationResponseJSON and the @simplewebauthn library performs the
  // structural validation we'd otherwise duplicate in Zod.
  assertionResponse: z.record(z.string(), z.unknown()),
  prfEncryptedSecretKey: z.string().min(1).max(PRF_ENCRYPTED_KEY_MAX_LENGTH),
  prfSecretKeyIv: hexIv,
  prfSecretKeyAuthTag: hexAuthTag,
  // The user.keyVersion at which the new wrapping was derived. Server CAS
  // rejects writes whose keyVersion drifted from the current value (#433/S4).
  keyVersion: z.number().int().min(0),
});

/**
 * POST /api/webauthn/credentials/[id]/prf
 *
 * Re-bootstrap the PRF wrapping for a credential after vault key rotation
 * cleared it. The flow is:
 *
 *   1. Caller fetched a challenge from `/options` (separate Redis namespace).
 *   2. Authenticator produced an assertion signing the challenge.
 *   3. Caller derives new PRF KEK + wraps the new secretKey, then POSTs here
 *      with the assertion + new wrapping + the keyVersion the wrapping was
 *      derived against.
 *
 * Security invariants:
 *   - Step-up auth (S3): the assertion is verified inside the same tx as the
 *     wrapping write, so a session-cookie attacker cannot write garbage PRF
 *     wrapping without proving authenticator possession.
 *   - keyVersion CAS (S4): the UPDATE rejects when user.keyVersion has moved
 *     since the wrapping was derived, preventing a stale rebootstrap from
 *     committing across a concurrent rotation.
 *   - Counter rollback (S-N4): verifyAuthenticationAssertion runs the counter
 *     CAS on the supplied tx, so it rolls back atomically with the keyVersion
 *     check when the latter rejects. Without this, a captured assertion
 *     replayed against this endpoint could commit the counter advance even
 *     when the wrap update fails.
 *   - prfSupported is intentionally NOT touched — it represents the
 *     authenticator's PRF capability, not the wrapping presence (#433/F8).
 */
async function handlePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { id: credentialRowId } = await params;

  const rl = await rateLimiter.check(`rl:webauthn_prf_rebootstrap:${userId}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(request, rebootstrapSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  // Ownership pre-check (cheap rejection before paying for an assertion verify).
  // Authoritative ownership is rechecked inside the helper via tx, so this is
  // defense-in-depth, not the security boundary.
  const ownedCredential = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id: credentialRowId, userId },
      select: { credentialId: true },
    }),
  );

  if (!ownedCredential) {
    // 404 vs 403: keep symmetric with credentials/[id] DELETE which returns 404
    // on cross-user attempts to avoid leaking existence.
    return notFound();
  }

  type RebootstrapOutcome =
    | { kind: "ok"; credentialId: string }
    | { kind: "stale"; currentKeyVersion: number }
    | { kind: "wrong_credential" }
    | { kind: "assertion_failed"; status: number; code: string; details?: string };

  let outcome: RebootstrapOutcome;
  try {
    outcome = await withUserTenantRls(userId, async () =>
      prisma.$transaction(async (tx) => {
        // Serialize concurrent PRF rebootstrap + rotation for the same user.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;

        // Step-up auth + counter CAS. Helper reads challenge from the
        // PRF-dedicated Redis key, performs verifyAuthentication, and runs the
        // counter CAS on this tx so it rolls back if any subsequent step fails.
        const verifyResult = await verifyAuthenticationAssertion(
          tx,
          userId,
          body.assertionResponse as unknown as AuthenticationResponseJSON,
          `webauthn:challenge:prf-rebootstrap:${userId}`,
          request.headers.get("user-agent"),
        );

        if (!verifyResult.ok) {
          return {
            kind: "assertion_failed",
            status: verifyResult.status,
            code: verifyResult.code,
            details: verifyResult.details,
          } as const;
        }

        if (verifyResult.credentialId !== ownedCredential.credentialId) {
          return { kind: "wrong_credential" } as const;
        }

        // keyVersion CAS — wrap update conditioned on user.keyVersion matching
        // the value the wrapping was derived against.
        const userRow = await tx.user.findUnique({
          where: { id: userId },
          select: { keyVersion: true },
        });
        if (!userRow || userRow.keyVersion !== body.keyVersion) {
          return {
            kind: "stale",
            currentKeyVersion: userRow?.keyVersion ?? -1,
          } as const;
        }

        await tx.webAuthnCredential.update({
          where: { id: credentialRowId },
          data: {
            prfEncryptedSecretKey: body.prfEncryptedSecretKey,
            prfSecretKeyIv: body.prfSecretKeyIv,
            prfSecretKeyAuthTag: body.prfSecretKeyAuthTag,
            // prfSupported intentionally NOT touched (#433/F8)
          },
        });

        return { kind: "ok", credentialId: verifyResult.credentialId } as const;
      }),
    );
  } catch (e) {
    // Unhandled DB / Redis errors bubble — handled by the framework as 500.
    throw e;
  }

  if (outcome.kind === "assertion_failed") {
    // Audit the failed assertion as well so adversarial rebootstrap-storms
    // surface in security logs (#433/S-N5 partial — failure visibility).
    await logAuditAsync({
      ...personalAuditBase(request, userId),
      action: AUDIT_ACTION.WEBAUTHN_PRF_REBOOTSTRAP,
      targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
      targetId: credentialRowId,
      metadata: {
        result: "assertion_failed",
        keyVersionAtBind: body.keyVersion,
        details: outcome.details ?? null,
      },
    });
    return errorResponse(
      API_ERROR[outcome.code as keyof typeof API_ERROR] ?? API_ERROR.VALIDATION_ERROR,
      outcome.status as 400 | 401 | 404 | 503,
      outcome.details ? { details: outcome.details } : undefined,
    );
  }

  if (outcome.kind === "wrong_credential") {
    // Asserted credential ID did not match the URL [id]. Treat as forbidden —
    // the assertion was for a different credential than the one being modified.
    await logAuditAsync({
      ...personalAuditBase(request, userId),
      action: AUDIT_ACTION.WEBAUTHN_PRF_REBOOTSTRAP,
      targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
      targetId: credentialRowId,
      metadata: {
        result: "wrong_credential",
        keyVersionAtBind: body.keyVersion,
      },
    });
    return forbidden();
  }

  if (outcome.kind === "stale") {
    // Adversarial rebootstrap-storm post-rotation surfaces as
    // result: "stale_keyversion" entries in the audit log (#433/S-N5).
    await logAuditAsync({
      ...personalAuditBase(request, userId),
      action: AUDIT_ACTION.WEBAUTHN_PRF_REBOOTSTRAP,
      targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
      targetId: credentialRowId,
      metadata: {
        result: "stale_keyversion",
        keyVersionAtBind: body.keyVersion,
        currentKeyVersion: outcome.currentKeyVersion,
      },
    });
    return NextResponse.json(
      { error: API_ERROR.CONFLICT, currentKeyVersion: outcome.currentKeyVersion },
      { status: 409 },
    );
  }

  // Success
  await logAuditAsync({
    ...personalAuditBase(request, userId),
    action: AUDIT_ACTION.WEBAUTHN_PRF_REBOOTSTRAP,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: credentialRowId,
    metadata: {
      result: "success",
      credentialId: outcome.credentialId,
      keyVersionAtBind: body.keyVersion,
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
