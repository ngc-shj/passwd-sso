import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { detectBestLocaleFromAcceptLanguage } from "@/i18n/locale-utils";

// GET /api/mcp/authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&code_challenge=...&code_challenge_method=S256&state=...
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    // Redirect to login — include return URL
    const loginUrl = new URL("/api/auth/signin", req.url);
    loginUrl.searchParams.set("callbackUrl", req.url);
    return NextResponse.redirect(loginUrl);
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

  // Detect locale from Accept-Language header and redirect to consent UI
  const locale = detectBestLocaleFromAcceptLanguage(req.headers.get("accept-language"));
  const consentUrl = new URL(`/${locale}/mcp/authorize`, req.url);
  // Forward all original OAuth params to the consent page
  sp.forEach((value, key) => {
    consentUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(consentUrl);
}
