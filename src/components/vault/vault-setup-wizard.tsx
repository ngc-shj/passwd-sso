"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
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
import { Loader2, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { getStrength, STRENGTH_COLORS } from "./passphrase-strength";

export function VaultSetupWizard() {
  const t = useTranslations("Vault");
  const { setup } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isValid =
    passphrase.length >= 10 &&
    passphrase === confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError("");
    try {
      await setup(passphrase);
    } catch {
      setError(t("setupError"));
    } finally {
      setLoading(false);
    }
  };

  const strength = getStrength(passphrase);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>{t("setupTitle")}</CardTitle>
          <CardDescription>{t("setupDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="passphrase">{t("passphrase")}</Label>
              <div className="relative">
                <Input
                  id="passphrase"
                  type={showPassphrase ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={t("passphrasePlaceholder")}
                  autoComplete="new-password"
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
              {passphrase && (
                <div className="space-y-1">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full ${
                          i < strength.level
                            ? STRENGTH_COLORS[strength.level]
                            : "bg-muted"
                        }`}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {strength.labelKey ? t(strength.labelKey) : ""}
                  </p>
                </div>
              )}
              {passphrase && passphrase.length < 10 && (
                <p className="text-xs text-destructive">
                  {t("passphraseMinLength")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm">{t("confirmPassphrase")}</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t("confirmPlaceholder")}
                autoComplete="new-password"
                required
              />
              {confirm && passphrase !== confirm && (
                <p className="text-xs text-destructive">
                  {t("passphraseMismatch")}
                </p>
              )}
            </div>

            <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200">
              {t("setupWarning")}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!isValid || loading}
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("setupButton")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
