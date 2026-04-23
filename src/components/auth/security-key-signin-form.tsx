"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, KeyRound } from "lucide-react";
import {
  isWebAuthnSupported,
  startPasskeyAuthentication,
  hexEncode,
} from "@/lib/auth/webauthn/webauthn-client";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useCallbackUrl } from "@/hooks/use-callback-url";
import { callbackUrlToHref } from "@/lib/auth/session/callback-url";

/** sessionStorage keys for passing PRF data to vault auto-unlock */
const SS_PRF_OUTPUT = "psso:prf-output";
const SS_PRF_DATA = "psso:prf-data";

export function SecurityKeySignInForm() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const callbackUrl = useCallbackUrl();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isWebAuthnSupported());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!trimmed) {
      setError(t("emailInvalid"));
      return;
    }

    setLoading(true);
    try {
      // 1. Get options with allowCredentials for this email
      const optionsRes = await fetchApi(
        API_PATH.AUTH_PASSKEY_OPTIONS_EMAIL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        },
      );

      if (!optionsRes.ok) {
        setError(t("securityKeySignInFailed"));
        return;
      }

      const { options, challengeId, prfSalt } = await optionsRes.json();

      // 2. WebAuthn ceremony (browser matches security key to allowCredentials)
      const { responseJSON, prfOutput } = await startPasskeyAuthentication(
        options,
        prfSalt || undefined,
      );

      // 3. Verify (reuses existing /api/auth/passkey/verify)
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
        setError(t("securityKeySignInFailed"));
        return;
      }

      const verifyData = await verifyRes.json();

      // 4. PRF data for vault auto-unlock
      if (prfOutput && verifyData.prf) {
        sessionStorage.setItem(SS_PRF_OUTPUT, hexEncode(prfOutput));
        sessionStorage.setItem(SS_PRF_DATA, JSON.stringify(verifyData.prf));
        prfOutput.fill(0);
      }

      sessionStorage.setItem("psso:webauthn-signin", "1");
      router.push(callbackUrlToHref(callbackUrl));
    } catch (err) {
      if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
        setError(t("securityKeySignInCancelled"));
      } else {
        setError(t("securityKeySignInFailed"));
      }
    } finally {
      setLoading(false);
    }
  };

  if (!supported) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("emailForSecurityKey")}
        disabled={loading}
        autoComplete="email webauthn"
      />
      <Button
        type="submit"
        variant="outline"
        size="lg"
        className="w-full justify-start gap-3 h-12"
        disabled={loading || !email.trim()}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <KeyRound className="h-5 w-5 text-blue-600" />
        )}
        {t("signInWithSecurityKey")}
      </Button>
      {error && (
        <p className="text-sm text-destructive text-center">{error}</p>
      )}
    </form>
  );
}
