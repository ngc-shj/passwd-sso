import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { detectBestLocaleFromAcceptLanguage } from "@/i18n/locale-utils";
import { serverAppUrl } from "@/lib/url-helpers";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";

const authorizeLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// Anti-enumeration: identical error for "client not found" and "redirect_uri mismatch"
async function validateOAuthRequest(clientId: string | null, redirectUri: string | null): Promise<boolean> {
  if (!clientId || !redirectUri) return false;
  const client = await withBypassRls(
    prisma,
    async () =>
      prisma.mcpClient.findFirst({
        where: { clientId },
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
  const rl = await authorizeLimiter.check(`rl:mcp_authz:${rateLimitKeyFromIp(ip ?? "unknown")}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 });
  }

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
