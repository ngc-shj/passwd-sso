"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useVault, VaultUnlockError } from "@/lib/vault/vault-context";
import { VAULT_UNLOCK_INTERRUPTED } from "@/lib/vault/vault-unlock-codes";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { API_PATH, SESSION_STORAGE_KEY } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { isWebAuthnSupported } from "@/lib/auth/webauthn/webauthn-client";
import { hasPrf } from "@/lib/auth/prf-handoff";
import { fetchApi, SessionChangedError } from "@/lib/url-helpers";
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
import { Fingerprint, Loader2, Lock, Eye, EyeOff } from "lucide-react";
import { ExtConnectBanner } from "@/components/extension/ext-connect-banner";
import { SessionExpiredCard } from "./session-expired-card";

/** @internal Exported for testing */
export function formatLockedUntil(lockedUntil: string | null | undefined, t: (key: string, values?: Record<string, string>) => string): string {
  if (!lockedUntil) return t("accountLocked");
  const diff = new Date(lockedUntil).getTime() - Date.now();
  if (diff <= 0) return t("accountLocked");
  const minutes = Math.ceil(diff / MS_PER_MINUTE);
  if (minutes >= 60) {
    const hours = Math.ceil(minutes / 60);
    return t("accountLockedWithTime", { time: t("hours", { count: String(hours) }) });
  }
  return t("accountLockedWithTime", { time: t("minutes", { count: String(minutes) }) });
}

export type UnlockErrorResolution =
  | { kind: "sessionExpired" }
  | { kind: "message"; message: string };

/**
 * The one mapping from an unlock failure to what the user sees. Each caller
 * supplies its own strings; an unknown code or a non-VaultUnlockError gets
 * `fallback`, never text taken from the error itself.
 */
export function resolveUnlockError(
  err: unknown,
  msgs: {
    lockedUntil: (lockedUntil: string | null | undefined) => string;
    rateLimited: string;
    unavailable: string;
    interrupted: string;
    sessionChanged: string;
    fallback: string;
  },
): UnlockErrorResolution {
  // The page's session now belongs to someone else and the page is reloading:
  // the request was refused before any route ran, so no attempt was made.
  if (err instanceof SessionChangedError) return { kind: "message", message: msgs.sessionChanged };
  if (!(err instanceof VaultUnlockError)) return { kind: "message", message: msgs.fallback };
  switch (err.code) {
    case API_ERROR.UNAUTHORIZED:
      return { kind: "sessionExpired" };
    case API_ERROR.ACCOUNT_LOCKED:
      return { kind: "message", message: msgs.lockedUntil(err.lockedUntil) };
    case API_ERROR.RATE_LIMIT_EXCEEDED:
      return { kind: "message", message: msgs.rateLimited };
    case API_ERROR.SERVICE_UNAVAILABLE:
      return { kind: "message", message: msgs.unavailable };
    // The credential was accepted, but the page was hidden before the vault
    // took the key: neither a wrong passphrase nor a failed attempt.
    case VAULT_UNLOCK_INTERRUPTED:
      return { kind: "message", message: msgs.interrupted };
    default:
      return { kind: "message", message: msgs.fallback };
  }
}

// Blocked storage (sandboxed iframe, disabled site data) throws on access; a
// missing flag only means no auto-unlock, so it must not take the screen down.
function readWebAuthnSignInFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN) === "1";
  } catch {
    return false;
  }
}

function consumeWebAuthnSignInFlag(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN);
  } catch {
    // Same blocked-storage case: the auto-unlock below must still run.
  }
}

export function VaultLockScreen() {
  const t = useTranslations("Vault");
  const tw = useTranslations("WebAuthn");
  const tApi = useTranslations("ApiErrors");
  const { unlock, unlockWithPasskey, unlockWithStoredPrf } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasPrfPasskeys, setHasPrfPasskeys] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const showUnlockError = useCallback(
    (err: unknown, msgs: Parameters<typeof resolveUnlockError>[1]) => {
      const resolved = resolveUnlockError(err, msgs);
      if (resolved.kind === "sessionExpired") {
        setSessionExpired(true);
      } else {
        setError(resolved.message);
      }
    },
    [],
  );

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
      showUnlockError(err, {
        lockedUntil: (lockedUntil) => formatLockedUntil(lockedUntil, t),
        rateLimited: t("rateLimited"),
        unavailable: t("retryLater"),
        interrupted: t("unlockInterrupted"),
        sessionChanged: tApi("sessionChanged"),
        fallback: t("unlockError"),
      });
      setPassphrase("");
    } finally {
      setLoading(false);
    }
  };

  const passkeyUnlockMessages = useMemo(
    () => ({
      lockedUntil: (lockedUntil: string | null | undefined) => formatLockedUntil(lockedUntil, t),
      rateLimited: t("rateLimited"),
      unavailable: tw("serviceUnavailable"),
      interrupted: t("unlockInterrupted"),
      sessionChanged: tApi("sessionChanged"),
      fallback: tw("unlockError"),
    }),
    [t, tw, tApi],
  );

  const handlePasskeyUnlock = useCallback(async () => {
    setPasskeyLoading(true);
    setError("");
    try {
      const success = await unlockWithPasskey();
      if (!success) {
        setError(tw("unlockError"));
      }
    } catch (err) {
      showUnlockError(err, passkeyUnlockMessages);
    } finally {
      setPasskeyLoading(false);
    }
  }, [unlockWithPasskey, tw, passkeyUnlockMessages, showUnlockError]);

  // Track whether we arrived via WebAuthn sign-in.
  // The ref persists across renders so we don't lose the flag while
  // waiting for the hasPrfPasskeys query to resolve.
  const webauthnSignInRef = useRef(readWebAuthnSignInFlag());

  // Auto-unlock vault after WebAuthn sign-in, once the PRF passkey check below
  // has settled. If PRF output was captured during sign-in (single-ceremony
  // flow), use it directly. Otherwise fall back to a separate ceremony.
  const autoUnlockRef = useRef<() => void>(() => {});
  useEffect(() => {
    autoUnlockRef.current = () => {
      if (!webauthnSignInRef.current) return;
      // Consume flag (one-shot)
      webauthnSignInRef.current = false;
      consumeWebAuthnSignInFlag();

      // PRF material is handed off in-memory (not sessionStorage) and consumed by
      // unlockWithStoredPrf; peek without consuming to decide whether to attempt.
      if (hasPrf()) {
        // Single-ceremony flow: use PRF output from sign-in (no second QR scan)
        setPasskeyLoading(true);
        unlockWithStoredPrf()
          .then((ok) => {
            if (!ok) setError(tw("unlockError"));
          })
          .catch((err) => showUnlockError(err, passkeyUnlockMessages))
          .finally(() => setPasskeyLoading(false));
      }
      // If sign-in did not produce PRF output (authenticator doesn't support PRF),
      // do NOT auto-trigger a separate ceremony — the user can manually unlock
      // with passphrase or click the passkey unlock button.
    };
  }, [unlockWithStoredPrf, tw, passkeyUnlockMessages, showUnlockError]);

  // Check if user has a passkey that can unlock now: PRF-capable AND holding
  // the server-side wrapping. A passkey registered while the vault was locked,
  // or one whose wrapping a key rotation cleared, is PRF-capable but cannot
  // unlock until it is re-bootstrapped.
  useEffect(() => {
    let cancelled = false;
    const prfCheck = isWebAuthnSupported()
      ? fetchApi(API_PATH.WEBAUTHN_CREDENTIALS)
          .then(async (res) => {
            if (res.ok) {
              const creds: Array<{ prfSupported: boolean; prfWrappingPresent: boolean }> =
                await res.json();
              setHasPrfPasskeys(creds.some((c) => c.prfSupported && c.prfWrappingPresent));
            }
          })
          .catch(() => {})
      : Promise.resolve();
    // An unmounted screen must not consume the one-shot sign-in flag: the
    // remounted one would then have nothing to auto-unlock with.
    void prfCheck.finally(() => {
      if (!cancelled) autoUnlockRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (sessionExpired) return <SessionExpiredCard />;

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
