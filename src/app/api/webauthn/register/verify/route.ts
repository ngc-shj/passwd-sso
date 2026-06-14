import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { parseBody } from "@/lib/http/parse-body";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, errorResponseWithMessage, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
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
  PER_CRED_SALT_HEX_RE,
} from "@/lib/auth/webauthn/webauthn-server";
import { parseDeviceFromUserAgent } from "@/lib/parse-user-agent";
import { sendEmail } from "@/lib/email";
import { passkeyRegisteredEmail } from "@/lib/email/templates/passkey-registered";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

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
    return unauthorized();
  }
  const userId = session.user.id;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:webauthn_reg_verify:${userId}`,
    scope: "webauthn.reg_verify",
    userId,
  });
  if (blocked) return blocked;

  const redis = getRedis();
  if (!redis) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
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

  // A02-8: the register-options route now stores a JSON envelope containing
  // both the challenge AND the per-credential PRF salt under the SAME Redis
  // key. This atomic binding prevents a race where two concurrent
  // register-options requests would silently brick the first request's
  // credential — see plan v2 §C4.
  const envelopeRaw = await redis.getdel(`webauthn:challenge:register:${userId}`);
  if (!envelopeRaw) {
    return errorResponse(API_ERROR.INVALID_CHALLENGE);
  }
  let challenge: string;
  let perCredentialSalt: string | null;
  try {
    const parsed: unknown = JSON.parse(envelopeRaw);
    // A02-8 S1: explicit runtime shape validation (Redis is an external trust
    // boundary — `as`-cast alone leaves room for tampered or legacy-shaped
    // values to flow through with `undefined` fields).
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).challenge !== "string" ||
      ((parsed as Record<string, unknown>).prfSalt !== null &&
        typeof (parsed as Record<string, unknown>).prfSalt !== "string")
    ) {
      return errorResponse(API_ERROR.INVALID_CHALLENGE);
    }
    const typed = parsed as { challenge: string; prfSalt: string | null };
    challenge = typed.challenge;
    perCredentialSalt = typed.prfSalt;
  } catch {
    return errorResponse(API_ERROR.INVALID_CHALLENGE);
  }

  const rpId = process.env.WEBAUTHN_RP_ID;
  if (!rpId) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  const origin = getRpOrigin(rpId);

  let verification;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verification = await verifyRegistration(response as any, challenge, rpId, origin);
  } catch {
    return errorResponseWithMessage(API_ERROR.VALIDATION_ERROR, "Registration verification failed");
  }

  if (!verification.verified || !verification.registrationInfo) {
    return errorResponseWithMessage(API_ERROR.VALIDATION_ERROR, "Registration verification failed");
  }

  const { registrationInfo } = verification;

  // v11: per-credential fields nested under registrationInfo.credential.
  // - credential.id is already a base64url string (no Uint8Array conversion).
  // - credential.publicKey is still binary and must be base64url-encoded for storage.
  // - credential.counter replaces the v9 top-level counter field.
  // credentialDeviceType and credentialBackedUp stay at the top level.
  const credentialId = registrationInfo.credential.id;
  const publicKey = uint8ArrayToBase64url(registrationInfo.credential.publicKey);
  const counter = registrationInfo.credential.counter;
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

  // A02-8: validate the per-credential salt fetched from Redis BEFORE persisting.
  // Defense-in-depth: a tampered Redis value would silently corrupt the PRF
  // binding (we don't recompute the v2 salt at unlock; the column is just
  // looked up). Reject non-canonical hex up front. Only persist prfSalt when
  // the credential actually reports PRF wrap fields (hasPrf=true).
  let prfSaltToPersist: string | null = null;
  if (hasPrf && perCredentialSalt !== null) {
    if (!PER_CRED_SALT_HEX_RE.test(perCredentialSalt)) {
      return errorResponseWithMessage(API_ERROR.VALIDATION_ERROR, "Invalid PRF salt envelope");
    }
    prfSaltToPersist = perCredentialSalt;
  }

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
    if (!user) throw new Error(API_ERROR.USER_NOT_FOUND);
    return user;
  });

  // Tenant policy: minimum PIN length enforcement.
  // Only enforced when the authenticator explicitly reports minPinLength.
  // Platform authenticators (Touch ID, Face ID, Windows Hello) do not report
  // this value — they are always allowed regardless of policy.
  const requireMinPin = userInfo.tenant?.requireMinPinLength ?? null;
  if (requireMinPin !== null && minPinLength !== null && minPinLength < requireMinPin) {
    return errorResponse(API_ERROR.PIN_LENGTH_POLICY_NOT_SATISFIED);
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
        prfSalt: prfSaltToPersist,
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
