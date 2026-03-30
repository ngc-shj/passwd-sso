import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { detectBestLocaleFromAcceptLanguage } from "@/i18n/locale-utils";
import { serverAppUrl } from "@/lib/url-helpers";

// GET /api/mcp/authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&code_challenge=...&code_challenge_method=S256&state=...
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
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
