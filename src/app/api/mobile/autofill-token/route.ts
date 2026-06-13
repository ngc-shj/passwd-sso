import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { withRequestLog } from "@/lib/http/with-request-log";
import { parseBody } from "@/lib/http/parse-body";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { unauthorized } from "@/lib/http/api-response";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants/auth/extension-token";
import { jwkThumbprint } from "@/lib/auth/dpop/verify";
import { issueAutofillToken } from "@/lib/auth/tokens/mobile-token";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";

export const runtime = "nodejs";

// The AutoFill extension's own DPoP public key (P-256). The minted token binds
// to its RFC 7638 thumbprint so only that extension can present it.
const BodySchema = z
  .object({
    jwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().min(1),
        y: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * POST /api/mobile/autofill-token
 *
 * Host-authenticated mint of a short-lived, passwords:write-only, DPoP-bound
 * token for the iOS AutoFill extension's passkey-registration upload. The host
 * (already paired, holding an IOS_APP token) authenticates with its own token +
 * DPoP; the body carries the EXTENSION's public JWK, which the server binds the
 * new token to. Returns the bearer once; never refreshable.
 */
export const POST = withRequestLog(async (req: NextRequest) => {
  // Gate on passwords:write — the same scope POST /api/passwords requires, which
  // the host's token already carries. This also runs the host's DPoP check.
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE });
  if (!authed.ok) return authed.response;
  // Only the host app's bearer token may broker an AutoFill token (it carries
  // tenantId). A bare session / API key is not the intended minter.
  if (authed.auth.type !== "token") return unauthorized();
  const { userId, tenantId } = authed.auth;

  const parsed = await parseBody(req, BodySchema);
  if (!parsed.ok) return parsed.response;
  const { jwk } = parsed.data;

  const cnfJkt = jwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const issued = await issueAutofillToken({ userId, tenantId, cnfJkt });

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_ISSUED,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    metadata: { clientKind: "IOS_AUTOFILL", scope: issued.scope },
  });

  return NextResponse.json(
    {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      scope: [issued.scope],
      cnfJkt,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
});
