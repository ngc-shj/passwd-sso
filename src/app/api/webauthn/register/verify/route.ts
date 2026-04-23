import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { parseBody } from "@/lib/http/parse-body";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited } from "@/lib/http/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import {
  PIN_LENGTH_MIN,
  PIN_LENGTH_MAX,
  WEBAUTHN_NICKNAME_MAX_LENGTH,
  PRF_ENCRYPTED_KEY_MAX_LENGTH,
  hexIv,
  hexAuthTag,
} from "@/lib/validations/common";
import {
  verifyRegistration,
  uint8ArrayToBase64url,
  getRpOrigin,
} from "@/lib/auth/webauthn/webauthn-server";
import { parseDeviceFromUserAgent } from "@/lib/parse-user-agent";
import { sendEmail } from "@/lib/email";
import { passkeyRegisteredEmail } from "@/lib/email/templates/passkey-registered";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const verifyRegistrationSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  nickname: z.string().max(WEBAUTHN_NICKNAME_MAX_LENGTH).optional(),
  prfEncryptedSecretKey: z.string().max(PRF_ENCRYPTED_KEY_MAX_LENGTH).optional(),
  prfSecretKeyIv: hexIv.optional(),
  prfSecretKeyAuthTag: hexAuthTag.optional(),
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

  const rl = await rateLimiter.check(`rl:webauthn_reg_verify:${userId}`);
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

  const result = await parseBody(req, verifyRegistrationSchema);
  if (!result.ok) return result.response;
  const {
    response,
    nickname,
    prfEncryptedSecretKey,
    prfSecretKeyIv,
    prfSecretKeyAuthTag,
  } = result.data;

  // Consume challenge from Redis (separate key from authentication)
  const challenge = await redis.getdel(`webauthn:challenge:register:${userId}`);
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

  // Extract transports from the response if available (allowlisted per WebAuthn spec)
  const VALID_TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawTransports: unknown[] = (response as any).response?.transports ?? [];
  const transports: string[] = rawTransports.filter(
    (t): t is string => typeof t === "string" && VALID_TRANSPORTS.has(t),
  );

  // credProps.rk is a client-supplied value (not authenticator-signed).
  // It is used ONLY for UI display. Never use it for auth/authz decisions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawRk = (response as any).clientExtensionResults?.credProps?.rk;
  const discoverable: boolean | null = typeof rawRk === "boolean" ? rawRk : null;

  // minPinLength is a client-supplied value (not authenticator-signed).
  // Policy enforcement is best-effort; compromised browsers can spoof this value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawMinPin = (response as any).clientExtensionResults?.minPinLength;
  const minPinLength: number | null =
    typeof rawMinPin === "number" && Number.isInteger(rawMinPin) && rawMinPin >= PIN_LENGTH_MIN && rawMinPin <= PIN_LENGTH_MAX
      ? rawMinPin : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLargeBlob = (response as any).clientExtensionResults?.largeBlob?.supported;
  const largeBlobSupported: boolean | null =
    typeof rawLargeBlob === "boolean" ? rawLargeBlob : null;

  const hasPrf = !!(prfEncryptedSecretKey && prfSecretKeyIv && prfSecretKeyAuthTag);
  const registeredDevice = parseDeviceFromUserAgent(req.headers.get("user-agent"));

  // First: get user info and check tenant PIN policy
  const userInfo = await withUserTenantRls(userId, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        tenantId: true,
        locale: true,
        tenant: { select: { requireMinPinLength: true } },
      },
    });
    if (!user) throw new Error("USER_NOT_FOUND");
    return user;
  });

  // Tenant policy: minimum PIN length enforcement.
  // Only enforced when the authenticator explicitly reports minPinLength.
  // Platform authenticators (Touch ID, Face ID, Windows Hello) do not report
  // this value — they are always allowed regardless of policy.
  const requireMinPin = userInfo.tenant?.requireMinPinLength ?? null;
  if (requireMinPin !== null && minPinLength !== null && minPinLength < requireMinPin) {
    return NextResponse.json(
      { error: API_ERROR.PIN_LENGTH_POLICY_NOT_SATISFIED },
      { status: 400 },
    );
  }

  const credential = await withUserTenantRls(userId, async () => {
    return prisma.webAuthnCredential.create({
      data: {
        userId,
        tenantId: userInfo.tenantId,
        credentialId,
        publicKey,
        counter: BigInt(counter),
        transports,
        deviceType,
        backedUp,
        discoverable,
        minPinLength,
        largeBlobSupported,
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

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_REGISTER,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: credential.id,
    metadata: {
      credentialId,
      deviceType,
      backedUp,
      prfSupported: hasPrf,
      discoverable,
      minPinLength,
      largeBlobSupported,
    },
  });

  // Send notification email (non-blocking)
  if (session.user.email) {
    const deviceName = nickname || registeredDevice || "Unknown";
    const { subject, html, text } = passkeyRegisteredEmail(
      deviceName,
      new Date(),
      userInfo.locale ?? "ja",
    );
    sendEmail({ to: session.user.email, subject, html, text });
  }

  return NextResponse.json(
    {
      id: credential.id,
      credentialId: credential.credentialId,
      nickname: credential.nickname,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      discoverable: credential.discoverable,
      minPinLength: credential.minPinLength,
      largeBlobSupported: credential.largeBlobSupported,
      prfSupported: credential.prfSupported,
      createdAt: credential.createdAt,
    },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
