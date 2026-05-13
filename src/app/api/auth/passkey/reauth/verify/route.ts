import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { parseBody } from "@/lib/http/parse-body";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { verifyAuthenticationAssertion } from "@/lib/auth/webauthn/webauthn-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const challengeIdSchema = /^[0-9a-f]{32}$/;

const requestSchema = z.object({
  credentialResponse: z.string().min(1),
  challengeId: z.string().regex(challengeIdSchema),
});

async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const rl = await rateLimiter.check(`rl:webauthn_reauth_verify:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, requestSchema);
  if (!result.ok) return result.response;

  let response: AuthenticationResponseJSON;
  try {
    response = JSON.parse(result.data.credentialResponse) as AuthenticationResponseJSON;
  } catch {
    return validationError();
  }

  const verifiedAt = new Date();
  const verification = await withBypassRls(
    prisma,
    () =>
      prisma.$transaction(async (tx) => {
        const assertion = await verifyAuthenticationAssertion(
          tx,
          session.user.id,
          response,
          `webauthn:challenge:reauth:${session.user.id}:${result.data.challengeId}`,
        );

        if (!assertion.ok) {
          return assertion;
        }

        await tx.session.update({
          where: { sessionToken },
          data: { passkeyVerifiedAt: verifiedAt },
        });

        return assertion;
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!verification.ok) {
    const code =
      verification.code === "SERVICE_UNAVAILABLE"
        ? API_ERROR.SERVICE_UNAVAILABLE
        : verification.code === "NOT_FOUND"
          ? API_ERROR.NOT_FOUND
          : API_ERROR.VALIDATION_ERROR;
    return errorResponse(
      code,
      verification.status,
      verification.details ? { details: verification.details } : undefined,
    );
  }

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.AUTH_PASSKEY_REAUTH,
    metadata: {
      credentialId: verification.credentialId,
    },
  });

  return NextResponse.json({
    ok: true,
    verifiedAt: verifiedAt.toISOString(),
  });
}

export const POST = withRequestLog(handlePOST);
