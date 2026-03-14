import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, ShieldAlert } from "lucide-react";

// Auth.js v5 error codes:
// - "Verification" — magic link token expired or already used
// - "AccessDenied" — signIn callback returned false (SSO policy, etc.)
// - "Configuration" — provider misconfiguration
type AuthErrorCode = "Verification" | "AccessDenied" | "Configuration";

function getErrorIcon(error?: string) {
  switch (error as AuthErrorCode) {
    case "Verification":
      return <Clock className="h-7 w-7 text-amber-500" />;
    case "AccessDenied":
      return <ShieldAlert className="h-7 w-7 text-destructive" />;
    default:
      return <AlertTriangle className="h-7 w-7 text-destructive" />;
  }
}

export default async function AuthErrorPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error: rawError } = await searchParams;
  setRequestLocale(locale);

  const t = await getTranslations("Auth");
  const tc = await getTranslations("Common");

  // Validate error code against known Auth.js codes
  const ALLOWED_ERROR_CODES: readonly string[] = [
    "Verification",
    "AccessDenied",
    "Configuration",
  ] as const;
  const error = ALLOWED_ERROR_CODES.includes(rawError ?? "")
    ? rawError
    : undefined;

  // Select error-specific title and description
  const titleKey =
    error === "Verification"
      ? "errorVerification"
      : error === "AccessDenied"
        ? "errorAccessDenied"
        : "error";

  const descKey =
    error === "Verification"
      ? "errorVerificationDescription"
      : error === "AccessDenied"
        ? "errorAccessDeniedDescription"
        : "errorDescription";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            {getErrorIcon(error)}
          </div>
          <div>
            <CardTitle className="text-2xl">{t(titleKey)}</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(descKey)}
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/auth/signin">{tc("tryAgain")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
