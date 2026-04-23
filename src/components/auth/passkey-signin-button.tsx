"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Fingerprint } from "lucide-react";
import { isWebAuthnSupported, startPasskeyAuthentication, hexEncode } from "@/lib/auth/webauthn/webauthn-client";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useCallbackUrl } from "@/hooks/use-callback-url";
import { callbackUrlToHref } from "@/lib/auth/session/callback-url";

/** sessionStorage keys for passing PRF data to vault auto-unlock */
const SS_PRF_OUTPUT = "psso:prf-output";
const SS_PRF_DATA = "psso:prf-data";

export function PasskeySignInButton() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const callbackUrl = useCallbackUrl();
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
      // 1. Get discoverable credential options from server (includes prfSalt)
      const optionsRes = await fetchApi(
        API_PATH.AUTH_PASSKEY_OPTIONS,
        { method: "POST" },
      );

      if (!optionsRes.ok) {
        setError(t("passkeySignInFailed"));
        return;
      }

      const { options, challengeId, prfSalt } = await optionsRes.json();

      // 2. Run WebAuthn authentication WITH PRF if salt is available.
      // This combines sign-in + PRF key derivation into a single ceremony
      // so users only need one authenticator interaction (e.g., one QR scan).
      const { responseJSON, prfOutput } = await startPasskeyAuthentication(
        options,
        prfSalt || undefined,
      );

      // 3. Verify and create database session via custom route.
      // Auth.js Credentials provider only supports JWT sessions, which is
      // incompatible with this app's database session strategy. This custom
      // route creates a database session directly.
      const verifyRes = await fetchApi(
        API_PATH.AUTH_PASSKEY_VERIFY,
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
        prfOutput?.fill(0);
        setError(t("passkeySignInFailed"));
        return;
      }

      const verifyData = await verifyRes.json();

      // 4. If PRF output was obtained and server returned PRF-wrapped key,
      // store both in sessionStorage for vault auto-unlock (no second ceremony).
      if (prfOutput && verifyData.prf) {
        sessionStorage.setItem(SS_PRF_OUTPUT, hexEncode(prfOutput));
        sessionStorage.setItem(SS_PRF_DATA, JSON.stringify(verifyData.prf));
        prfOutput.fill(0);
      }

      // 5. Set flag for vault auto-unlock after dashboard navigation
      sessionStorage.setItem("psso:webauthn-signin", "1");

      // 6. Navigate to callback destination (preserves ext_connect for extension)
      router.push(callbackUrlToHref(callbackUrl));
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
