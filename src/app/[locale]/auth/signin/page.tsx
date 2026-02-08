import { redirect } from "@/i18n/navigation";
import { auth } from "@/auth";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SignInButton } from "@/components/auth/signin-button";
import { Shield, KeyRound } from "lucide-react";

export default async function SignInPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
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
    redirect({ href: "/dashboard", locale });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-7 w-7 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl">passwd-sso</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("signInDescription")}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
          <div className="relative">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
              {tc("or")}
            </span>
          </div>
          <SignInButton
            provider="saml-jackson"
            label={t("signInWithSSO", {
              provider: process.env.SAML_PROVIDER_NAME ?? "SSO",
            })}
            icon={<Shield className="h-5 w-5 text-blue-600" />}
          />
          <p className="text-center text-xs text-muted-foreground pt-4">
            {t("authorizedOnly")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
