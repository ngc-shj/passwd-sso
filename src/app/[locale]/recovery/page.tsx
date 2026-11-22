"use client";

import { useTranslations } from "next-intl";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { useRecoveryFlow } from "@/hooks/vault/use-recovery-flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STRENGTH_COLORS } from "@/components/vault/passphrase-strength";
import { PASSPHRASE_MIN_LENGTH } from "@/lib/validations";
import { Link } from "@/i18n/navigation";
import { AlertTriangle, ArrowLeft, Loader2, ShieldCheck } from "lucide-react";

export default function RecoveryPage() {
  const tCommon = useTranslations("Common");
  const t = useTranslations("Recovery");
  const tVault = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const {
    step,
    recoveryKeyInput,
    setRecoveryKeyInput,
    newPassphrase,
    setNewPassphrase,
    confirmPassphrase,
    setConfirmPassphrase,
    loading,
    error,
    strength,
    isValid,
    handleVerify,
    handleReset,
    continueToDashboard,
  } = useRecoveryFlow();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {tCommon("back")}
        </Link>

        <div className="flex flex-col items-center gap-2 text-center">
          <ShieldCheck className="h-10 w-10 text-muted-foreground" />
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>

        {step === "input" && (
          <form onSubmit={handleVerify} onKeyDown={preventIMESubmit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <div className="space-y-2">
              <Label htmlFor="recovery-key">{t("recoveryKeyLabel")}</Label>
              <Input
                id="recovery-key"
                type="text"
                value={recoveryKeyInput}
                onChange={(e) => setRecoveryKeyInput(e.target.value)}
                placeholder={t("recoveryKeyPlaceholder")}
                className="font-mono"
                autoComplete="off"
                required
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={!recoveryKeyInput || loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {loading ? t("verifying") : t("verified").replace(".", "")}
            </Button>
          </form>
        )}

        {step === "new-passphrase" && (
          <form onSubmit={handleReset} onKeyDown={preventIMESubmit} className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
              {t("verified")}
            </p>

            <div className="space-y-2">
              <Label htmlFor="new-pass">{t("newPassphrase")}</Label>
              <Input
                id="new-pass"
                type="password"
                value={newPassphrase}
                onChange={(e) => setNewPassphrase(e.target.value)}
                placeholder={t("newPassphrasePlaceholder")}
                autoComplete="new-password"
                required
              />
              {newPassphrase && (
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
                    {strength.labelKey ? tVault(strength.labelKey) : ""}
                  </p>
                </div>
              )}
              {newPassphrase && newPassphrase.length < PASSPHRASE_MIN_LENGTH && (
                <p className="text-xs text-destructive">
                  {tVault("passphraseMinLength")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-pass">{t("confirmNewPassphrase")}</Label>
              <Input
                id="confirm-pass"
                type="password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder={t("confirmNewPassphrasePlaceholder")}
                autoComplete="new-password"
                required
              />
              {confirmPassphrase && newPassphrase !== confirmPassphrase && (
                <p className="text-xs text-destructive">
                  {tVault("passphraseMismatch")}
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={!isValid || loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {loading ? t("resetting") : t("resetPassphrase")}
            </Button>
          </form>
        )}

        {step === "reset-invalidation-failed" && (
          <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{tApi("sessionInvalidateFailed")}</span>
            </div>
            <Button type="button" className="w-full" onClick={continueToDashboard}>
              {t("continueToDashboard")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
