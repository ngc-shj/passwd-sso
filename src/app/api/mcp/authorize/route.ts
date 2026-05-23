import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { detectBestLocaleFromAcceptLanguage } from "@/i18n/locale-utils";
import { serverAppUrl } from "@/lib/url-helpers";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { requireRecentSession } from "@/lib/auth/session/step-up";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const authorizeLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 20,
  failClosedOnRedisError: true,
});

// Anti-enumeration: identical error for "client not found", "client inactive",
// and "redirect_uri mismatch". A07-4 adds `isActive: true` to the WHERE clause
// so revoked clients fail upfront (defense-in-depth — token endpoint already
// gates via validateMcpToken in oauth-server.ts:170,376).
async function validateOAuthRequest(clientId: string | null, redirectUri: string | null): Promise<boolean> {
  if (!clientId || !redirectUri) return false;
  const client = await withBypassRls(
    prisma,
    async (tx) =>
      tx.mcpClient.findFirst({
        where: { clientId, isActive: true }, // A07-4
        select: { redirectUris: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );
  if (!client) return false;
  return client.redirectUris.includes(redirectUri);
}

// GET /api/mcp/authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&code_challenge=...&code_challenge_method=S256&state=...
export async function GET(req: NextRequest) {
  // Rate limit by IP to prevent brute-force client_id enumeration
  const ip = extractClientIp(req);
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: authorizeLimiter,
    key: `rl:mcp_authz:${rateLimitKeyFromIp(ip ?? "unknown")}`,
    scope: "mcp.authorize",
    userId: null,
    envelope: "oauth",
    rateLimitedEnvelope: () =>
      NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 }),
  });
  if (blocked) return blocked;

  const session = await auth();
  if (!session?.user?.id) {
    // Validate OAuth params early to prevent login-then-error UX
    const sp = req.nextUrl.searchParams;
    const clientId = sp.get("client_id");
    const redirectUri = sp.get("redirect_uri");
    if (!(await validateOAuthRequest(clientId, redirectUri))) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    // Redirect to login — use external-facing URL (not req.url which may be internal)
    const loginUrl = serverAppUrl("/api/auth/signin");
    const callbackUrl = serverAppUrl(req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(`${loginUrl}?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const stepUpError = await requireRecentSession(req);
  if (stepUpError) return stepUpError;

  const sp = req.nextUrl.searchParams;
  const clientId = sp.get("client_id");
  const redirectUri = sp.get("redirect_uri");
  const responseType = sp.get("response_type");
  const codeChallenge = sp.get("code_challenge");
  const codeChallengeMethod = sp.get("code_challenge_method") ?? "S256";

  // Validate required params before redirecting to consent page
  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (codeChallengeMethod !== "S256") {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" },
      { status: 400 },
    );
  }

  // Validate client_id and redirect_uri against DB before redirecting to consent page
  if (!(await validateOAuthRequest(clientId, redirectUri))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Detect locale and build consent URL using external-facing origin
  const locale = detectBestLocaleFromAcceptLanguage(req.headers.get("accept-language"));
  const consentPath = serverAppUrl(`/${locale}/mcp/authorize`);
  const consentUrl = new URL(consentPath);
  // Forward all original OAuth params to the consent page
  sp.forEach((value, key) => {
    consentUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(consentUrl.toString());
}
