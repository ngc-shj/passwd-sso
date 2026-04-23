import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { unauthorized, errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

// Providers that do NOT support passkey-based sign-in
const OIDC_SAML_PROVIDERS = new Set(["google", "saml-jackson"]);

// GET /api/user/auth-provider — Check if user can use passkey sign-in
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  try {
    const accounts = await withBypassRls(prisma, () =>
      prisma.account.findMany({
        where: { userId: session.user.id },
        select: { provider: true },
      }),
      BYPASS_PURPOSE.AUTH_FLOW,
    );

    // User can use passkey sign-in if:
    // - They have no Account records (passkey-only user — no OAuth/email link), OR
    // - They have at least one non-OIDC/SAML provider (e.g., nodemailer)
    const canPasskeySignIn =
      accounts.length === 0 ||
      accounts.some((a) => !OIDC_SAML_PROVIDERS.has(a.provider));

    return NextResponse.json({ canPasskeySignIn });
  } catch {
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }
}

export const GET = withRequestLog(handleGET);
