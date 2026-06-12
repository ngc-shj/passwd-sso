"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Fingerprint } from "lucide-react";
import {
  isWebAuthnSupported,
  startPasskeyAuthentication,
  abortInFlightCeremony,
} from "@/lib/auth/webauthn/webauthn-client";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useCallbackUrl } from "@/hooks/use-callback-url";
import { callbackUrlToHref, isApiCallbackUrl } from "@/lib/auth/session/callback-url";
import { stashPrf } from "@/lib/auth/prf-handoff";

export function PasskeySignInButton() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const callbackUrl = useCallbackUrl();
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isWebAuthnSupported());
    // Release any ceremony left pending if the user navigates away mid-prompt,
    // so it can't silently block the next passkey attempt.
    return abortInFlightCeremony;
  }, []);

  const handlePasskeySignIn = async () => {
    setLoading(true);
    setError(null);

    // Held in the outer scope so `finally` can zeroize it on every path where
    // ownership was NOT transferred to the handoff (set to null after stashPrf).
    let prfOutput: Uint8Array | null = null;
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
      const result = await startPasskeyAuthentication(
        options,
        prfSalt || undefined,
      );
      prfOutput = result.prfOutput;

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
            credentialResponse: JSON.stringify(result.responseJSON),
            challengeId,
          }),
        },
      );

      if (!verifyRes.ok) {
        setError(t("passkeySignInFailed"));
        return;
      }

      const verifyData = await verifyRes.json();

      // 4. If PRF output was obtained and server returned PRF-wrapped key,
      // hand both to the dashboard in-memory (NOT sessionStorage, which XSS can
      // read) for vault auto-unlock without a second ceremony. Survives the
      // client-side router.push below; a full reload drops it → manual unlock.
      // Ownership of the buffer transfers to the handoff: null it out so the
      // finally below does not zeroize what the consumer must still read.
      if (prfOutput && verifyData.prf) {
        stashPrf({ prfOutput, prfData: verifyData.prf });
        prfOutput = null;
      }

      // 5. Set flag for vault auto-unlock after dashboard navigation
      sessionStorage.setItem("psso:webauthn-signin", "1");

      // 6. Navigate to callback destination (preserves ext_connect for extension).
      // API callbacks (e.g. iOS /api/mobile/authorize) live outside the [locale]
      // segment; the next-intl router would inject the active locale and 404, so
      // navigate to those plainly.
      if (isApiCallbackUrl(callbackUrl)) {
        window.location.assign(callbackUrl);
      } else {
        router.push(callbackUrlToHref(callbackUrl));
      }
    } catch (err) {
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        setError(t("passkeySignInCancelled"));
      } else {
        setError(t("passkeySignInFailed"));
      }
    } finally {
      // Zeroize on every path where the buffer was not handed off (error throw,
      // verify failure, no PRF bundle). No-op after a successful stashPrf.
      prfOutput?.fill(0);
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
