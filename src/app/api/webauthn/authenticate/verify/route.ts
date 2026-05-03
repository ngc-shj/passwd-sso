import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { parseBody } from "@/lib/http/parse-body";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited } from "@/lib/http/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { verifyAuthenticationAssertion } from "@/lib/auth/webauthn/webauthn-server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const verifyAuthenticationSchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

// POST /api/webauthn/authenticate/verify
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const rl = await rateLimiter.check(`rl:webauthn_auth_verify:${userId}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, verifyAuthenticationSchema);
  if (!result.ok) return result.response;
  const { response } = result.data;

  const verifyResult = await withUserTenantRls(userId, async () =>
    verifyAuthenticationAssertion(
      prisma,
      userId,
      response as unknown as AuthenticationResponseJSON,
      `webauthn:challenge:authenticate:${userId}`,
      req.headers.get("user-agent"),
    ),
  );

  if (!verifyResult.ok) {
    return NextResponse.json(
      { error: API_ERROR[verifyResult.code as keyof typeof API_ERROR] ?? API_ERROR.VALIDATION_ERROR, details: verifyResult.details },
      { status: verifyResult.status },
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
