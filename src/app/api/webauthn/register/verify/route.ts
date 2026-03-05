import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import {
  verifyRegistration,
  uint8ArrayToBase64url,
  getRpOrigin,
} from "@/lib/webauthn-server";
import { parseDeviceFromUserAgent } from "@/lib/parse-user-agent";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const verifyRegistrationSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  nickname: z.string().max(100).optional(),
  prfEncryptedSecretKey: z.string().max(10_000).optional(),
  prfSecretKeyIv: z.string().max(24).optional(),
  prfSecretKeyAuthTag: z.string().max(32).optional(),
}).refine(
  (d) => {
    const prfFields = [d.prfEncryptedSecretKey, d.prfSecretKeyIv, d.prfSecretKeyAuthTag];
    const provided = prfFields.filter(Boolean).length;
    return provided === 0 || provided === 3;
  },
  { message: "PRF fields must be all provided or all omitted", path: ["prfEncryptedSecretKey"] },
);

// POST /api/webauthn/register/verify
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const rl = await rateLimiter.check(`webauthn:reg-verify:${userId}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = verifyRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const {
    response,
    nickname,
    prfEncryptedSecretKey,
    prfSecretKeyIv,
    prfSecretKeyAuthTag,
  } = parsed.data;

  // Consume challenge from Redis (separate key from authentication)
  const challenge = await redis.getDel(`webauthn:challenge:register:${userId}`);
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

  const origin = getRpOrigin(rpId);

  let verification;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verification = await verifyRegistration(response as any, challenge, rpId, origin);
  } catch {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Registration verification failed" },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: "Registration verification failed" },
      { status: 400 },
    );
  }

  const { registrationInfo } = verification;

  const credentialId = uint8ArrayToBase64url(registrationInfo.credentialID);
  const publicKey = uint8ArrayToBase64url(registrationInfo.credentialPublicKey);
  const counter = registrationInfo.counter;
  const deviceType = registrationInfo.credentialDeviceType;
  const backedUp = registrationInfo.credentialBackedUp;

  // Extract transports from the response if available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transports: string[] = (response as any).response?.transports ?? [];

  const hasPrf = !!(prfEncryptedSecretKey && prfSecretKeyIv && prfSecretKeyAuthTag);
  const registeredDevice = parseDeviceFromUserAgent(req.headers.get("user-agent"));

  const credential = await withUserTenantRls(userId, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!user) throw new Error("USER_NOT_FOUND");

    return prisma.webAuthnCredential.create({
      data: {
        userId,
        tenantId: user.tenantId,
        credentialId,
        publicKey,
        counter: BigInt(counter),
        transports,
        deviceType,
        backedUp,
        nickname: nickname ?? null,
        prfSupported: hasPrf,
        registeredDevice,
        ...(hasPrf
          ? {
              prfEncryptedSecretKey,
              prfSecretKeyIv,
              prfSecretKeyAuthTag,
            }
          : {}),
      },
    });
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_REGISTER,
    userId,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: credential.id,
    metadata: {
      credentialId,
      deviceType,
      backedUp,
      prfSupported: hasPrf,
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: credential.id,
      credentialId: credential.credentialId,
      nickname: credential.nickname,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      prfSupported: credential.prfSupported,
      createdAt: credential.createdAt,
    },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
