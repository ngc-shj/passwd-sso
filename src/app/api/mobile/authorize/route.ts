/**
 * GET /api/mobile/authorize — Issue a one-time bridge code for the iOS host app.
 *
 * Step 1 of the iOS pairing handshake. The web app reaches this URL inside
 * `ASWebAuthenticationSession` after the user completes Auth.js sign-in. The
 * iOS app sends along PKCE+state pre-binding (computed in the host app) and
 * the Secure-Enclave device pubkey it will use for DPoP on subsequent calls.
 *
 * The route:
 *   1. Verifies an Auth.js session is active (the user is signed in).
 *   2. Validates the four required query params.
 *   3. Persists a single-use bridge code (60s TTL) bound to {userId, tenantId,
 *      state, code_challenge, device_pubkey}.
 *   4. Redirects (302) to the canonical Universal-Link URL
 *      `<self-origin>/api/mobile/authorize/redirect?code=<bridge>&state=<state>`.
 *
 * `redirect_uri` is NOT a query parameter — the server computes the redirect
 * target itself. Any client-supplied `redirect_uri` is silently ignored
 * (closes open-redirect per F15).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  unauthorized,
  zodValidationError,
} from "@/lib/http/api-response";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { extractRequestMeta } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import { BRIDGE_CODE_TTL_MS } from "@/lib/constants";
import { generateShareToken } from "@/lib/crypto/crypto-server";

export const runtime = "nodejs";

// base64url-no-padding regex; accept lengths used by the iOS host app.
// state: 32 random bytes → 43 chars; code_challenge: 32-byte SHA-256 → 43 chars;
// device_pubkey: P-256 SubjectPublicKeyInfo DER (~91 bytes) → ~122 chars.
// We enforce a generous upper bound rather than exact lengths so the server
// stays decoupled from a specific encoding choice on the client.
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const AuthorizeQuerySchema = z.object({
  client_kind: z.literal("ios"),
  state: z.string().min(43).max(64).regex(BASE64URL_RE),
  code_challenge: z.string().min(43).max(64).regex(BASE64URL_RE),
  device_pubkey: z.string().min(64).max(512).regex(BASE64URL_RE),
});

async function handleGET(req: NextRequest): Promise<Response> {
  // 1. Auth.js session.
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // 2. Validate query params.
  const url = new URL(req.url);
  const parsed = AuthorizeQuerySchema.safeParse({
    client_kind: url.searchParams.get("client_kind"),
    state: url.searchParams.get("state"),
    code_challenge: url.searchParams.get("code_challenge"),
    device_pubkey: url.searchParams.get("device_pubkey"),
  });
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }
  const { state, code_challenge: codeChallenge, device_pubkey: devicePubkey } =
    parsed.data;

  // 3. Resolve the user's tenant. Required for the bridge-code row's RLS column.
  const userId = session.user.id;
  const userRecord = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    }),
  );
  if (!userRecord) {
    return unauthorized();
  }

  // 4. Persist the bridge code under bypass-RLS (cross-tenant lookup later).
  const code = generateShareToken();
  const codeHash = hashToken(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIDGE_CODE_TTL_MS);
  const meta = extractRequestMeta(req);

  await withBypassRls(
    prisma,
    async () =>
      prisma.mobileBridgeCode.create({
        data: {
          codeHash,
          userId,
          tenantId: userRecord.tenantId,
          state,
          codeChallenge,
          devicePubkey,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  // 5. Compute canonical redirect target — never honour a client-supplied
  // redirect_uri (closes open-redirect per F15).
  let redirectTarget: string;
  try {
    redirectTarget = canonicalHtu({ route: "/api/mobile/authorize/redirect" });
  } catch {
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }
  const redirectUrl = new URL(redirectTarget);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  return NextResponse.redirect(redirectUrl.toString(), 302);
}

export const GET = withRequestLog(handleGET);
