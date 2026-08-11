import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { parseBody } from "@/lib/http/parse-body";
import { WEBAUTHN_RESPONSE_MAX } from "@/lib/validations/common";
import { AUDIT_CREDENTIAL_ID_MAX_LENGTH, BASE64URL_RE } from "@/lib/validations/common.server";
import { getSessionTokenDigest } from "@/app/api/sessions/helpers";
import {
  verifyAssertionForCredential,
  CHALLENGE_ID_RE,
  type VerifyAssertionResult,
} from "@/lib/auth/webauthn/webauthn-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});
const requestSchema = z.object({
  credentialResponse: z.string().min(1).max(WEBAUTHN_RESPONSE_MAX),
  challengeId: z.string().regex(CHALLENGE_ID_RE),
});

type VerifierDenial = Extract<VerifyAssertionResult, { ok: false }>;

/**
 * Outcome of the binding-aware reauth decision (C4 step 6), computed inside
 * the transaction and mapped to a response + audit emission outside it.
 * A discriminated union rather than reusing VerifyAssertionResult directly:
 * "unauthorized" and "unavailable" are reached WITHOUT calling the verifier
 * at all (step 3), and "mismatch" reclassifies two of the verifier's own
 * denial reasons under a re-check the verifier itself has no reason to run.
 */
type ReauthOutcome =
  | { kind: "unauthorized" }
  | {
      kind: "unavailable";
      auditReason: "provider" | "no_binding" | "credential_missing";
      boundCredentialId: string | null;
      presentedCredentialId: string | undefined;
    }
  | {
      kind: "mismatch";
      auditReason: "presented_credential" | "signature_invalid" | "counter_mismatch";
      boundCredentialId: string | null;
      presentedCredentialId: string | undefined;
      verifierResult: VerifierDenial;
    }
  | { kind: "passthrough"; verifierResult: VerifierDenial }
  | { kind: "success"; credentialId: string };

/**
 * Bound a base64url credential id read from OUR OWN row before it reaches
 * audit metadata. `webauthn_credentials.credential_id` is `@db.Text`
 * (unbounded) and the WebAuthn wire format allows ids up to 65,535 raw
 * bytes — self-registerable against one's own account — so an oversized
 * registered id could otherwise trip `truncateMetadata` and erase the whole
 * metadata object, including the sibling field (finding Q4/M13). A value of
 * exactly the bound is kept whole; over it, keep the first N chars and mark
 * the truncation so the row stays honest about what it dropped.
 */
function boundCredentialIdMetadata(
  credentialId: string | null,
): { boundCredentialId: string | null; boundCredentialIdTruncated?: true } {
  if (credentialId === null) {
    return { boundCredentialId: null };
  }
  if (credentialId.length > AUDIT_CREDENTIAL_ID_MAX_LENGTH) {
    return {
      boundCredentialId: credentialId.slice(0, AUDIT_CREDENTIAL_ID_MAX_LENGTH),
      boundCredentialIdTruncated: true,
    };
  }
  return { boundCredentialId: credentialId };
}

/**
 * The presented credential id comes from the REQUEST BODY (`response.id`),
 * not our own row, so it is charset-unvalidated and bounded only by
 * WEBAUTHN_RESPONSE_MAX over the whole response string. Validate it against
 * the base64url charset and a 512-char bound before it reaches metadata; on
 * rejection record `null` plus an explicit rejected flag so "not recorded"
 * is never spelled the same as "absent" (finding P2).
 */
function presentedCredentialIdMetadata(
  responseCredentialId: string | undefined,
): { presentedCredentialId: string | null; presentedCredentialIdRejected?: true } {
  if (
    responseCredentialId !== undefined &&
    responseCredentialId.length <= AUDIT_CREDENTIAL_ID_MAX_LENGTH &&
    BASE64URL_RE.test(responseCredentialId)
  ) {
    return { presentedCredentialId: responseCredentialId };
  }
  return { presentedCredentialId: null, presentedCredentialIdRejected: true };
}

function buildDenialMetadata(
  reason: string,
  boundCredentialId: string | null,
  presentedCredentialId: string | undefined,
): Record<string, unknown> {
  return {
    reason,
    ...boundCredentialIdMetadata(boundCredentialId),
    ...presentedCredentialIdMetadata(presentedCredentialId),
  };
}

async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const sessionTokenDigest = getSessionTokenDigest(req);
  if (!sessionTokenDigest) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_reauth_verify:${session.user.id}`,
    scope: "auth.passkey_reauth_verify",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, requestSchema);
  if (!result.ok) return result.response;

  let response: AuthenticationResponseJSON;
  try {
    response = JSON.parse(result.data.credentialResponse) as AuthenticationResponseJSON;
  } catch {
    return validationError();
  }

  const userId = session.user.id;
  // Read once, ahead of the verifier: used both for the presence check in
  // "unavailable"/"passthrough" metadata and (for a genuine denial) it is
  // guaranteed present at this point per the requestSchema/JSON.parse above,
  // but defensively cast the same way the shared verifier does (a bare `as`
  // cast does not guarantee the runtime shape matches the claimed type).
  const responseCredentialId = (response as unknown as { id?: string }).id;

  const verifiedAt = new Date();
  const outcome: ReauthOutcome = await withBypassRls(
    prisma,
    async (tx) => {
      // C4 step 1: read through the session's `authCredential` relation so
      // the bound credential's base64url id is captured from THIS query,
      // before any race window — a later lookup keyed by the FK would come
      // back empty in exactly the case the audit row matters most (N4).
      const sessionRow = await tx.session.findUnique({
        where: { sessionToken: sessionTokenDigest },
        select: {
          provider: true,
          authCredentialId: true,
          // userId comes along so the binding can be checked to belong to this
          // session's own user. The FK constrains only that the row exists —
          // referential integrity runs outside RLS and spans no tenant or user
          // predicate — so "the writer only ever binds this user's credential"
          // is an assumption of C2's, not something the schema enforces. Left
          // unchecked, a corrupt binding would put another user's credentialId
          // into this user's audit metadata.
          authCredential: { select: { credentialId: true, userId: true } },
        },
      });

      if (!sessionRow) {
        return { kind: "unauthorized" };
      }

      if (sessionRow.provider !== "webauthn") {
        return {
          kind: "unavailable",
          auditReason: "provider",
          boundCredentialId: null,
          presentedCredentialId: responseCredentialId,
        };
      }

      if (sessionRow.authCredentialId === null) {
        return {
          kind: "unavailable",
          auditReason: "no_binding",
          boundCredentialId: null,
          presentedCredentialId: responseCredentialId,
        };
      }

      // A binding that resolves to another user's credential is not a binding.
      // Fail closed as no_binding rather than credential_missing (the row is
      // there, it is just not ours) and record no id — the whole point is to
      // keep the other user's identifier out of this row.
      if (
        sessionRow.authCredential !== null &&
        sessionRow.authCredential.userId !== userId
      ) {
        return {
          kind: "unavailable",
          auditReason: "no_binding",
          boundCredentialId: null,
          presentedCredentialId: responseCredentialId,
        };
      }

      const boundCredentialId = sessionRow.authCredential?.credentialId ?? null;

      // C4 step 4: the freshness path — only the bound credential may
      // satisfy this. The challenge is NOT consumed above (redis.getdel
      // lives inside the verifier), so returning before this call preserves
      // the one-shot ceremony (I9b).
      const assertion = await verifyAssertionForCredential(
        tx,
        userId,
        sessionRow.authCredentialId,
        response,
        `webauthn:challenge:reauth:${userId}:${result.data.challengeId}`,
      );

      if (assertion.ok) {
        await tx.session.update({
          where: { sessionToken: sessionTokenDigest },
          data: { passkeyVerifiedAt: verifiedAt },
        });
        return { kind: "success", credentialId: assertion.credentialId };
      }

      // C4 step 6: classify the denial on the verifier's structured `reason`,
      // never on `details` text (R47) — an exhaustive switch whose `default`
      // denies closed and emits nothing.
      switch (assertion.reason) {
        case "credential_not_found":
        case "counter_mismatch": {
          // The existence re-check runs only for these two reasons — "did
          // the bound row vanish?" is the actual question they raise.
          const stillBound = await tx.webAuthnCredential.findFirst({
            where: { id: sessionRow.authCredentialId, userId },
            select: { id: true },
          });
          if (!stillBound) {
            return {
              kind: "unavailable",
              auditReason: "credential_missing",
              boundCredentialId,
              presentedCredentialId: responseCredentialId,
            };
          }
          return {
            kind: "mismatch",
            auditReason:
              assertion.reason === "credential_not_found"
                ? "presented_credential"
                : "counter_mismatch",
            boundCredentialId,
            presentedCredentialId: responseCredentialId,
            verifierResult: assertion,
          };
        }
        case "signature_invalid":
          return {
            kind: "mismatch",
            auditReason: "signature_invalid",
            boundCredentialId,
            presentedCredentialId: responseCredentialId,
            verifierResult: assertion,
          };
        case "challenge_missing":
        case "response_credential_id_missing":
        case "redis_unavailable":
        case "rp_id_unconfigured":
          return { kind: "passthrough", verifierResult: assertion };
        default: {
          const _exhaustive: never = assertion.reason;
          void _exhaustive;
          return {
            kind: "unavailable",
            auditReason: "credential_missing",
            boundCredentialId,
            presentedCredentialId: responseCredentialId,
          };
        }
      }
    },
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  switch (outcome.kind) {
    case "unauthorized":
      return unauthorized();

    case "unavailable": {
      await logAuditAsync({
        ...personalAuditBase(req, userId),
        action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
        metadata: buildDenialMetadata(
          outcome.auditReason,
          outcome.boundCredentialId,
          outcome.presentedCredentialId,
        ),
      });
      return errorResponse(API_ERROR.PASSKEY_REAUTH_UNAVAILABLE, 403);
    }

    case "mismatch": {
      await logAuditAsync({
        ...personalAuditBase(req, userId),
        action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH,
        metadata: buildDenialMetadata(
          outcome.auditReason,
          outcome.boundCredentialId,
          outcome.presentedCredentialId,
        ),
      });
      if (outcome.auditReason === "presented_credential") {
        return errorResponse(API_ERROR.PASSKEY_REAUTH_CREDENTIAL_MISMATCH, 403);
      }
      // signature_invalid / counter_mismatch: the verifier's own response is
      // unchanged — only the audit trail is new (findings P1/Q2).
      return errorResponse(
        API_ERROR.VALIDATION_ERROR,
        outcome.verifierResult.status,
        outcome.verifierResult.details ? { details: outcome.verifierResult.details } : undefined,
      );
    }

    case "passthrough": {
      const code =
        outcome.verifierResult.code === "SERVICE_UNAVAILABLE"
          ? API_ERROR.SERVICE_UNAVAILABLE
          : API_ERROR.VALIDATION_ERROR;
      return errorResponse(
        code,
        outcome.verifierResult.status,
        outcome.verifierResult.details ? { details: outcome.verifierResult.details } : undefined,
      );
    }

    case "success": {
      await logAuditAsync({
        ...personalAuditBase(req, userId),
        action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH,
        metadata: {
          credentialId: outcome.credentialId,
        },
      });
      return NextResponse.json({
        ok: true,
        verifiedAt: verifiedAt.toISOString(),
      });
    }
  }
}

export const POST = withRequestLog(handlePOST);
