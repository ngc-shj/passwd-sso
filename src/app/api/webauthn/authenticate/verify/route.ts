import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { parseBody } from "@/lib/parse-body";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  verifyAuthentication,
  getRpOrigin,
  base64urlToUint8Array,
} from "@/lib/webauthn-server";
import type { AuthenticatorDevice } from "@simplewebauthn/types";
import { parseDeviceFromUserAgent } from "@/lib/parse-user-agent";

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

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 503 },
    );
  }

  const result = await parseBody(req, verifyAuthenticationSchema);
  if (!result.ok) return result.response;
  const { response } = result.data;

  // Consume challenge from Redis (separate key from registration)
  const challenge = await redis.getdel(`webauthn:challenge:authenticate:${userId}`);
  if (!challenge) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Challenge expired or already used" },
      { status: 400 },
    );
  }

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 503 },
    );
  }

  // Extract credentialId from response to look up the stored credential
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responseCredentialId = (response as any).id as string | undefined;
  if (!responseCredentialId) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Missing credential ID in response" },
      { status: 400 },
    );
  }

  // Look up stored credential
  const storedCredential = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { userId, credentialId: responseCredentialId },
    }),
  );

  if (!storedCredential) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND, details: "Credential not found" },
      { status: 404 },
    );
  }

  // Build authenticator device object for verification
  const authenticator: AuthenticatorDevice = {
    credentialPublicKey: base64urlToUint8Array(storedCredential.publicKey),
    credentialID: base64urlToUint8Array(storedCredential.credentialId),
    counter: Number(storedCredential.counter),
    transports: storedCredential.transports as AuthenticatorDevice["transports"],
  };

  const origin = getRpOrigin(rpId);

  let verification;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verification = await verifyAuthentication(response as any, challenge, rpId, origin, authenticator);
  } catch {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Authentication verification failed" },
      { status: 400 },
    );
  }

  if (!verification.verified) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Authentication verification failed" },
      { status: 400 },
    );
  }

  // Update counter atomically with CAS check (prevents replay/clone attacks)
  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  const lastUsedDevice = parseDeviceFromUserAgent(req.headers.get("user-agent"));
  const updatedRows = await withUserTenantRls(userId, async () =>
    prisma.$executeRaw`
      UPDATE "webauthn_credentials"
      SET counter = ${newCounter},
          "last_used_at" = ${new Date()},
          "last_used_device" = ${lastUsedDevice}
      WHERE id = ${storedCredential.id}
        AND counter = ${storedCredential.counter}
    `,
  );

  if (updatedRows === 0) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Counter mismatch — credential may be cloned. Re-register your passkey." },
      { status: 400 },
    );
  }

  // Return PRF encrypted data if the credential has it
  const prfData = storedCredential.prfEncryptedSecretKey
    ? {
        prfEncryptedSecretKey: storedCredential.prfEncryptedSecretKey,
        prfSecretKeyIv: storedCredential.prfSecretKeyIv,
        prfSecretKeyAuthTag: storedCredential.prfSecretKeyAuthTag,
      }
    : null;

  return NextResponse.json({
    verified: true,
    credentialId: storedCredential.credentialId,
    ...(prfData ? { prf: prfData } : {}),
  });
}

export const POST = withRequestLog(handlePOST);
