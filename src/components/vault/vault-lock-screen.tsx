"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault, VaultUnlockError } from "@/lib/vault-context";
import { API_ERROR } from "@/lib/api-error-codes";
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
import { Loader2, Lock, Eye, EyeOff } from "lucide-react";

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
  const { unlock } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
          <form onSubmit={handleSubmit} className="space-y-4">
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
              disabled={!passphrase || loading}
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("unlock")}
            </Button>

            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Link href="/recovery" className="hover:underline">
                {t("forgotPassphrase")}
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
