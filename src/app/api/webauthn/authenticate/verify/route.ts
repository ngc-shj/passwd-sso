import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { parseBody } from "@/lib/http/parse-body";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  verifyAuthenticationAssertion,
  CHALLENGE_ID_RE,
} from "@/lib/auth/webauthn/webauthn-server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

const verifyAuthenticationSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  // 32-hex-char id minted by authenticate/options; scopes the challenge to this flow.
  challengeId: z.string().regex(CHALLENGE_ID_RE),
});

// POST /api/webauthn/authenticate/verify
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_auth_verify:${userId}`,
    scope: "webauthn.auth_verify",
    userId,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, verifyAuthenticationSchema);
  if (!result.ok) return result.response;
  const { response, challengeId } = result.data;

  const verifyResult = await withUserTenantRls(userId, async () =>
    verifyAuthenticationAssertion(
      prisma,
      userId,
      response as unknown as AuthenticationResponseJSON,
      `webauthn:challenge:authenticate:${userId}:${challengeId}`,
      req.headers.get("user-agent"),
    ),
  );

  if (!verifyResult.ok) {
    return errorResponse(
      API_ERROR[verifyResult.code as keyof typeof API_ERROR] ?? API_ERROR.VALIDATION_ERROR,
      verifyResult.status,
      { details: verifyResult.details },
    );
  }

  // Return PRF encrypted data if the credential has it
  const prfData = verifyResult.storedPrf.encryptedSecretKey
    ? {
        prfEncryptedSecretKey: verifyResult.storedPrf.encryptedSecretKey,
        prfSecretKeyIv: verifyResult.storedPrf.iv,
        prfSecretKeyAuthTag: verifyResult.storedPrf.authTag,
      }
    : null;

  return NextResponse.json({
    verified: true,
    credentialId: verifyResult.credentialId,
    ...(prfData ? { prf: prfData } : {}),
  });
}

export const POST = withRequestLog(handlePOST);
