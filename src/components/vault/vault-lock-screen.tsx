"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault, VaultUnlockError } from "@/lib/vault-context";
import { API_ERROR } from "@/lib/api-error-codes";
import { API_PATH } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { isWebAuthnSupported } from "@/lib/auth/webauthn-client";
import { fetchApi } from "@/lib/url-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { Fingerprint, Loader2, Lock, LogIn, Eye, EyeOff } from "lucide-react";
import { ExtConnectBanner } from "@/components/extension/ext-connect-banner";

/** @internal Exported for testing */
export function formatLockedUntil(lockedUntil: string | null | undefined, t: (key: string, values?: Record<string, string>) => string): string {
  if (!lockedUntil) return t("accountLocked");
  const diff = new Date(lockedUntil).getTime() - Date.now();
  if (diff <= 0) return t("accountLocked");
  const minutes = Math.ceil(diff / 60_000);
  if (minutes >= 60) {
    const hours = Math.ceil(minutes / 60);
    return t("accountLockedWithTime", { time: t("hours", { count: String(hours) }) });
  }
  return t("accountLockedWithTime", { time: t("minutes", { count: String(minutes) }) });
}

export function VaultLockScreen() {
  const t = useTranslations("Vault");
  const tw = useTranslations("WebAuthn");
  const router = useRouter();
  const { unlock, unlockWithPasskey, unlockWithStoredPrf } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasPrfPasskeys, setHasPrfPasskeys] = useState(false);
  const [prfChecked, setPrfChecked] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Check if user has PRF-capable passkeys
  useEffect(() => {
    if (!isWebAuthnSupported()) {
      setPrfChecked(true);
      return;
    }

    fetchApi(API_PATH.WEBAUTHN_CREDENTIALS)
      .then(async (res) => {
        if (res.ok) {
          const creds: Array<{ prfSupported: boolean }> = await res.json();
          setHasPrfPasskeys(creds.some((c) => c.prfSupported));
        }
      })
      .catch(() => {})
      .finally(() => setPrfChecked(true));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;

    setLoading(true);
    setError("");
    try {
      const success = await unlock(passphrase);
      if (!success) {
        setError(t("wrongPassphrase"));
        setPassphrase("");
      }
    } catch (err) {
      if (err instanceof VaultUnlockError) {
        switch (err.code) {
          case API_ERROR.UNAUTHORIZED:
            setSessionExpired(true);
            return;
          case API_ERROR.ACCOUNT_LOCKED:
            setError(formatLockedUntil(err.lockedUntil, t));
            break;
          case API_ERROR.RATE_LIMIT_EXCEEDED:
            setError(t("rateLimited"));
            break;
          case API_ERROR.SERVICE_UNAVAILABLE:
            setError(t("retryLater"));
            break;
          default:
            setError(t("unlockError"));
        }
      } else {
        setError(t("unlockError"));
      }
      setPassphrase("");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyUnlock = useCallback(async () => {
    setPasskeyLoading(true);
    setError("");
    try {
      const success = await unlockWithPasskey();
      if (!success) {
        setError(tw("unlockError"));
      }
    } catch (err) {
      if (err instanceof VaultUnlockError) {
        switch (err.code) {
          case API_ERROR.UNAUTHORIZED:
            setSessionExpired(true);
            return;
          case API_ERROR.ACCOUNT_LOCKED:
            setError(formatLockedUntil(err.lockedUntil, t));
            break;
          case API_ERROR.RATE_LIMIT_EXCEEDED:
            setError(t("rateLimited"));
            break;
          case API_ERROR.SERVICE_UNAVAILABLE:
            setError(tw("serviceUnavailable"));
            break;
          default:
            setError(tw("unlockError"));
        }
      } else {
        setError(tw("unlockError"));
      }
    } finally {
      setPasskeyLoading(false);
    }
  }, [unlockWithPasskey, t, tw]);

  // Track whether we arrived via WebAuthn sign-in.
  // The ref persists across renders so we don't lose the flag while
  // waiting for the hasPrfPasskeys query to resolve.
  const webauthnSignInRef = useRef(
    typeof window !== "undefined" &&
      sessionStorage.getItem("psso:webauthn-signin") === "1",
  );

  // Auto-unlock vault after WebAuthn sign-in.
  // If PRF output was captured during sign-in (single-ceremony flow),
  // use it directly. Otherwise fall back to a separate ceremony.
  useEffect(() => {
    if (!webauthnSignInRef.current || !prfChecked) return;
    // Consume flag (one-shot)
    webauthnSignInRef.current = false;
    sessionStorage.removeItem("psso:webauthn-signin");

    const hasStoredPrf = !!(
      sessionStorage.getItem("psso:prf-output") &&
      sessionStorage.getItem("psso:prf-data")
    );

    if (hasStoredPrf) {
      // Single-ceremony flow: use PRF output from sign-in (no second QR scan)
      setPasskeyLoading(true);
      unlockWithStoredPrf()
        .then((ok) => {
          if (!ok) setError(tw("unlockError"));
        })
        .catch((err) => {
          if (err instanceof VaultUnlockError) {
            if (err.code === API_ERROR.UNAUTHORIZED) {
              setSessionExpired(true);
              return;
            }
            setError(formatLockedUntil(err.lockedUntil, t));
          } else {
            setError(tw("unlockError"));
          }
        })
        .finally(() => setPasskeyLoading(false));
    }
    // If sign-in did not produce PRF output (authenticator doesn't support PRF),
    // do NOT auto-trigger a separate ceremony — the user can manually unlock
    // with passphrase or click the passkey unlock button.
  }, [prfChecked, unlockWithStoredPrf, t, tw]);

  if (sessionExpired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/30 to-background p-4">
        <Card className="w-full max-w-sm rounded-xl border">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <LogIn className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle>{t("sessionExpired")}</CardTitle>
            <CardDescription>{t("sessionExpiredDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              onClick={() => router.push("/auth/signin")}
            >
              <LogIn className="h-4 w-4 mr-2" />
              {t("goToSignIn")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/30 to-background p-4">
      <Card className="w-full max-w-sm rounded-xl border">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle>{t("locked")}</CardTitle>
          <CardDescription>{t("lockedDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ExtConnectBanner className="mb-4" />
          <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="unlock-passphrase">{t("passphrase")}</Label>
              <div className="relative">
                <Input
                  id="unlock-passphrase"
                  type={showPassphrase ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    setError("");
                  }}
                  placeholder={t("enterPassphrase")}
                  autoComplete="current-password"
                  autoFocus
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                >
                  {showPassphrase ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!passphrase || loading || passkeyLoading}
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("unlock")}
            </Button>

            {/* Passkey unlock button */}
            {hasPrfPasskeys && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t("or")}</span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={loading || passkeyLoading}
                  onClick={handlePasskeyUnlock}
                >
                  {passkeyLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Fingerprint className="h-4 w-4 mr-2" />
                  )}
                  {passkeyLoading ? tw("unlocking") : tw("unlockWithPasskey")}
                </Button>
              </>
            )}

            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Link href="/recovery" className="hover:underline">
                {t("recoverPassphrase")}
              </Link>
              <span>|</span>
              <Link href="/vault-reset" className="hover:underline">
                {t("resetVault")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
