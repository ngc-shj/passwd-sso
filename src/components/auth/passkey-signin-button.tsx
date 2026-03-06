"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Fingerprint } from "lucide-react";
import { isWebAuthnSupported, startPasskeyAuthentication } from "@/lib/webauthn-client";
import { API_PATH } from "@/lib/constants";
import { withBasePath } from "@/lib/url-helpers";

export function PasskeySignInButton() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isWebAuthnSupported());
  }, []);

  const handlePasskeySignIn = async () => {
    setLoading(true);
    setError(null);

    try {
      // 1. Get discoverable credential options from server
      const optionsRes = await fetch(
        withBasePath(API_PATH.AUTH_PASSKEY_OPTIONS),
        { method: "POST" },
      );

      if (!optionsRes.ok) {
        setError(t("passkeySignInFailed"));
        return;
      }

      const { options, challengeId } = await optionsRes.json();

      // 2. Run WebAuthn authentication (no PRF for sign-in)
      const { responseJSON } = await startPasskeyAuthentication(options);

      // 3. Verify and create database session via custom route.
      // Auth.js Credentials provider only supports JWT sessions, which is
      // incompatible with this app's database session strategy. This custom
      // route creates a database session directly.
      const verifyRes = await fetch(
        withBasePath(API_PATH.AUTH_PASSKEY_VERIFY),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credentialResponse: JSON.stringify(responseJSON),
            challengeId,
          }),
        },
      );

      if (!verifyRes.ok) {
        setError(t("passkeySignInFailed"));
        return;
      }

      // 4. Set flag for PRF auto-unlock after dashboard navigation
      sessionStorage.setItem("psso:webauthn-signin", "1");

      // 5. Navigate to dashboard
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        setError(t("passkeySignInCancelled"));
      } else {
        setError(t("passkeySignInFailed"));
      }
    } finally {
      setLoading(false);
    }
  };

  if (!supported) {
    return null;
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="lg"
        className="w-full justify-start gap-3 h-12"
        onClick={handlePasskeySignIn}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Fingerprint className="h-5 w-5 text-purple-600" />
        )}
        {t("signInWithPasskey")}
      </Button>
      {error && (
        <p className="text-sm text-destructive text-center">{error}</p>
      )}
    </div>
  );
}
