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
} from "@/lib/auth/webauthn/webauthn-client";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useCallbackUrl } from "@/hooks/use-callback-url";
import { callbackUrlToHref } from "@/lib/auth/session/callback-url";
import { stashPrf } from "@/lib/auth/prf-handoff";

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
    // Held in the outer scope so `finally` can zeroize it on every path where
    // ownership was NOT transferred to the handoff (set to null after stashPrf).
    let prfOutput: Uint8Array | null = null;
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
      const result = await startPasskeyAuthentication(
        options,
        prfSalt || undefined,
      );
      prfOutput = result.prfOutput;

      // 3. Verify (reuses existing /api/auth/passkey/verify)
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
        setError(t("securityKeySignInFailed"));
        return;
      }

      const verifyData = await verifyRes.json();

      // 4. Hand PRF data to the dashboard in-memory (NOT sessionStorage, which
      // XSS can read) for vault auto-unlock. Survives the client-side router.push
      // below; a full reload drops it → manual unlock. Ownership of the buffer
      // transfers to the handoff: null it out so the finally below does not
      // zeroize what the consumer must still read.
      if (prfOutput && verifyData.prf) {
        stashPrf({ prfOutput, prfData: verifyData.prf });
        prfOutput = null;
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
      // Zeroize on every path where the buffer was not handed off (error throw,
      // verify failure, no PRF bundle). No-op after a successful stashPrf.
      prfOutput?.fill(0);
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
