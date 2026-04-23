import { redirect } from "@/i18n/navigation";
import { auth } from "@/auth";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { APP_NAME } from "@/lib/constants";
import { resolveCallbackUrl, callbackUrlToHref } from "@/lib/auth/session/callback-url";
import { getAppOrigin } from "@/lib/url-helpers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SignInButton } from "@/components/auth/signin-button";
import { EmailSignInForm } from "@/components/auth/email-signin-form";
import { PasskeySignInButton } from "@/components/auth/passkey-signin-button";
import { SecurityKeySignInForm } from "@/components/auth/security-key-signin-form";
import { Shield, ChevronDown } from "lucide-react";
import { AppIcon } from "@/components/ui/app-icon";
import { ExtConnectBanner } from "@/components/extension/ext-connect-banner";
import { parseAllowedGoogleDomains } from "@/lib/url/google-domain";

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { locale } = await params;
  const { callbackUrl: rawCallbackUrl } = await searchParams;
  setRequestLocale(locale);

  const t = await getTranslations("Auth");
  const tc = await getTranslations("Common");

  let session = null;
  try {
    session = await auth();
  } catch {
    // DB may be unavailable; continue to show sign-in page
  }

  if (session?.user) {
    // Resolve callbackUrl using env-based origin (never from request headers)
    let origin = "";
    try {
      const appOrigin = getAppOrigin();
      if (appOrigin) origin = new URL(appOrigin).origin;
    } catch {
      // Malformed env var — fall back to empty origin (relative paths only)
    }
    const resolved = resolveCallbackUrl(rawCallbackUrl ?? null, origin);
    // Strip basePath + locale: next-intl redirect() re-adds both
    const href = callbackUrlToHref(resolved);
    redirect({ href, locale });
  }

  const hasGoogle = !!(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
  );
  const isGoogleMultiDomain =
    hasGoogle && parseAllowedGoogleDomains().length > 1;
  const hasSaml = !!(
    process.env.JACKSON_URL &&
    process.env.AUTH_JACKSON_ID &&
    process.env.AUTH_JACKSON_SECRET
  );
  const hasSso = hasGoogle || hasSaml;
  const hasEmail = !!process.env.EMAIL_PROVIDER;
  const hasWebAuthn = !!process.env.WEBAUTHN_RP_ID;

  // Passkey sign-in only available when SSO is not configured (individual user mode)
  const showPasskeySignIn = !hasSso && hasWebAuthn;
  const showEmailSignIn = !hasSso && hasEmail;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <AppIcon className="h-7 w-7" />
          </div>
          <div>
            <CardTitle className="text-2xl">{APP_NAME}</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("signInDescription")}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ExtConnectBanner />
          {/* SSO buttons (enterprise mode) */}
          {hasGoogle && (
            <>
              <SignInButton
                provider="google"
                label={t("signInWithGoogle")}
                icon={
                  <svg className="h-5 w-5" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                }
              />
              {isGoogleMultiDomain && (
                <p className="text-xs text-muted-foreground text-center -mt-2" data-testid="google-domain-hint">
                  {t("googleMultiDomainHint")}
                </p>
              )}
            </>
          )}
          {hasGoogle && hasSaml && (
            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                {tc("or")}
              </span>
            </div>
          )}
          {hasSaml && (
            <SignInButton
              provider="saml-jackson"
              label={t("signInWithSSO", {
                provider: process.env.SAML_PROVIDER_NAME ?? "SSO",
              })}
              icon={<Shield className="h-5 w-5 text-blue-600" />}
            />
          )}

          {/* Individual user mode: passkey + email */}
          {showPasskeySignIn && (
            <>
              <PasskeySignInButton />
              <details className="group">
                <summary className="flex w-full cursor-pointer list-none items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 [&::-webkit-details-marker]:hidden">
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                  {t("alternativeSignIn")}
                </summary>
                <div className="pt-2">
                  <SecurityKeySignInForm />
                </div>
              </details>
            </>
          )}
          {showPasskeySignIn && showEmailSignIn && (
            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                {t("orContinueWith")}
              </span>
            </div>
          )}
          {showEmailSignIn && (
            <EmailSignInForm />
          )}

          <p className="text-center text-xs text-muted-foreground pt-4">
            {hasSso ? t("authorizedOnly") : t("personalWelcome")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
