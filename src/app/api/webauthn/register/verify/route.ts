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
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { invalidateUserSessionsCache } from "@/lib/auth/session/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
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
  CHALLENGE_ID_RE,
} from "@/lib/auth/webauthn/webauthn-server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
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
  // 32-hex-char id minted by register/options; scopes the challenge to this flow.
  challengeId: z.string().regex(CHALLENGE_ID_RE),
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

  // D5 (#959): a session cookie alone must not be able to mint a durable
  // credential — registration always requires the same recent-sign-in proof
  // the other step-up routes (and credential delete) do. Checked before the
  // challenge is consumed, so a stale session's rejected attempt does not
  // burn the one-time challenge.
  // @stepup id:webauthn-register-verify-post method:POST
  const stepUp = await requireRecentCurrentAuthMethod(req, userId);
  if (stepUp) return stepUp;

  const result = await parseBody(req, verifyRegistrationSchema);
  if (!result.ok) return result.response;
  const {
    response,
    challengeId,
    nickname,
    prfEncryptedSecretKey,
    prfSecretKeyIv,
    prfSecretKeyAuthTag,
  } = result.data;

  // A02-8: the register-options route stores a JSON envelope containing both the
  // challenge AND the per-credential PRF salt under the same Redis key. The key
  // is scoped by per-flow challengeId so concurrent register flows from the same
  // user never overwrite each other; userId is also in the key so a flow can only
  // consume its own user's challenge — see plan v2 §C4.
  const envelopeRaw = await redis.getdel(
    `webauthn:challenge:register:${userId}:${challengeId}`,
  );
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

  // `response` arrives as z.record(z.string(), z.unknown()) — the schema does NOT
  // validate its fields, so every `typeof` narrowing below IS the validation.
  // Two distinct shapes are read off it and they must not be conflated:
  //   - as a verifyRegistration() argument -> the library's RegistrationResponseJSON
  //   - as a source of extension outputs   -> a local wire type with `unknown`
  //     fields, because minPinLength/largeBlob exist on NEITHER lib.dom's
  //     AuthenticationExtensionsClientOutputs NOR @simplewebauthn's narrower copy.
  const responseWire = response as {
    response?: { transports?: unknown };
    clientExtensionResults?: {
      credProps?: { rk?: unknown };
      minPinLength?: unknown;
      largeBlob?: { supported?: unknown };
      prf?: { enabled?: unknown; results?: unknown };
    };
  };

  let verification;
  try {
    verification = await verifyRegistration(
      response as unknown as RegistrationResponseJSON,
      challenge,
      rpId,
      origin,
    );
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
  const rawTransportsRaw = responseWire.response?.transports;
  // G3: a hostile client can send a non-array here; `.filter` on a string throws.
  const rawTransports: unknown[] = Array.isArray(rawTransportsRaw) ? rawTransportsRaw : [];
  const transports: string[] = rawTransports.filter(
    (t): t is string => typeof t === "string" && VALID_TRANSPORTS.has(t),
  );

  // credProps.rk is a client-supplied value (not authenticator-signed).
  // It is used ONLY for UI display. Never use it for auth/authz decisions.
  const rawRk = responseWire.clientExtensionResults?.credProps?.rk;
  const discoverable: boolean | null = typeof rawRk === "boolean" ? rawRk : null;

  // minPinLength is a client-supplied value (not authenticator-signed).
  // Policy enforcement is best-effort; compromised browsers can spoof this value.
  const rawMinPin = responseWire.clientExtensionResults?.minPinLength;
  const minPinLength: number | null =
    typeof rawMinPin === "number" && Number.isInteger(rawMinPin) && rawMinPin >= PIN_LENGTH_MIN && rawMinPin <= PIN_LENGTH_MAX
      ? rawMinPin : null;

  const rawLargeBlob = responseWire.clientExtensionResults?.largeBlob?.supported;
  const largeBlobSupported: boolean | null =
    typeof rawLargeBlob === "boolean" ? rawLargeBlob : null;

  const hasPrf = !!(prfEncryptedSecretKey && prfSecretKeyIv && prfSecretKeyAuthTag);

  // D5 side-effect (#959): the authenticator's own PRF extension output is a
  // client-supplied value (not authenticator-signed, like credProps.rk above)
  // — read the SAME way, no new body field. `enabled === true` is Chrome's
  // shape; `results` present (even without `enabled`) covers browsers that
  // skip the capability flag and report the evaluated output directly.
  const rawPrf = responseWire.clientExtensionResults?.prf;
  const prfExtensionEnabled =
    typeof rawPrf === "object" && rawPrf !== null &&
    (rawPrf.enabled === true || "results" in rawPrf);

  // `prfSupported` is the credential's PRF CAPABILITY (wrap fields present, OR
  // the extension itself reports support) — distinct from `hasPrf`, which is
  // specifically "the client sent wrap fields to persist now". A credential
  // with no wrap (locked-vault registration) can still be PRF-capable, which
  // is what offers re-bootstrap later (see passkey-credentials-card.tsx).
  const prfSupported = hasPrf || prfExtensionEnabled;

  // A02-8: validate the per-credential salt fetched from Redis BEFORE persisting.
  // Defense-in-depth: a tampered Redis value would silently corrupt the PRF
  // binding (we don't recompute the v2 salt at unlock; the column is just
  // looked up). Reject non-canonical hex up front. Only persist prfSalt when
  // the credential reports PRF capability (wrap fields or the extension itself).
  let prfSaltToPersist: string | null = null;
  if (prfSupported && perCredentialSalt !== null) {
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
  //
  // FAIL-CLOSED: userInfo.tenantId is a non-null FK RESTRICT, so a null tenant
  // relation here is data corruption, NOT "no policy" — an unset requirement is
  // requireMinPinLength=null on a real row. Reading `tenant?.… ?? null` on a
  // vanished tenant would silently skip the PIN-length gate. Refuse instead.
  if (!userInfo.tenant) {
    throw new Error(`webauthn register: tenant ${userInfo.tenantId} not found`);
  }
  const requireMinPin = userInfo.tenant.requireMinPinLength;
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
        prfSupported,
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

  // F5/F19 (#959): every writer of `hasPasskey` invalidates the user's cached
  // sessions (cross-tenant — passkeys are user-global) so the layout, page
  // proxy and API gate stop serving a stale `hasPasskey: false` snapshot. The
  // credential row has already committed, so neither failure mode fails this
  // response (entries still expire on TTL): a Redis tombstone failure does not
  // throw and is counted in the audit row's `cacheTombstoneFailures`; a thrown
  // error (the session read) is logged.
  let cacheInvalidation: { totalSessions: number; cacheTombstoneFailures: number } | null = null;
  try {
    cacheInvalidation = await invalidateUserSessionsCache(userId);
  } catch (err) {
    getLogger().error(
      { error: errorLogFields(err), userId, _logType: "webauthn.register_verify_cache_invalidation_failed" },
      "webauthn register/verify: invalidateUserSessionsCache failed",
    );
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_REGISTER,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: credential.id,
    metadata: {
      credentialId,
      deviceType,
      backedUp,
      prfSupported,
      discoverable,
      minPinLength,
      largeBlobSupported,
      ...(cacheInvalidation
        ? {
            cacheInvalidatedSessions: cacheInvalidation.totalSessions,
            cacheTombstoneFailures: cacheInvalidation.cacheTombstoneFailures,
          }
        : {}),
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
