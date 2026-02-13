"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useVault } from "@/lib/vault-context";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { getStrength, STRENGTH_COLORS } from "./passphrase-strength";

interface ChangePassphraseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePassphraseDialog({
  open,
  onOpenChange,
}: ChangePassphraseDialogProps) {
  const t = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const { changePassphrase } = useVault();

  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isValid =
    currentPassphrase.length > 0 &&
    newPassphrase.length >= 10 &&
    newPassphrase === confirmPassphrase;

  const strength = getStrength(newPassphrase);

  function resetForm() {
    setCurrentPassphrase("");
    setNewPassphrase("");
    setConfirmPassphrase("");
    setShowNew(false);
    setError("");
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError("");
    try {
      await changePassphrase(currentPassphrase, newPassphrase);
      toast.success(t("passphraseChanged"));
      handleOpenChange(false);
    } catch (err: unknown) {
      const apiErr = err as { error?: string } | undefined;
      const errorCode = apiErr?.error;

      if (errorCode === "VERIFIER_NOT_SET") {
        setError(t("verifierNotSetHint"));
      } else if (errorCode === "VERIFIER_VERSION_UNSUPPORTED") {
        setError(t("verifierVersionUnsupported"));
      } else if (errorCode === "INVALID_PASSPHRASE") {
        setError(tApi("invalidPassphrase"));
      } else if (errorCode === "RATE_LIMIT_EXCEEDED") {
        setError(tApi("rateLimitExceeded"));
      } else if (errorCode) {
        setError(tApi(apiErrorToI18nKey(errorCode)));
      } else {
        setError(t("changePassphraseFailed"));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("changePassphrase")}</DialogTitle>
          <DialogDescription>
            {t("changePassphraseDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-2">
            <Label htmlFor="cp-current">{t("currentPassphrase")}</Label>
            <Input
              id="cp-current"
              type="password"
              value={currentPassphrase}
              onChange={(e) => setCurrentPassphrase(e.target.value)}
              placeholder={t("currentPassphrasePlaceholder")}
              autoComplete="current-password"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cp-new">{t("newPassphrase")}</Label>
            <div className="relative">
              <Input
                id="cp-new"
                type={showNew ? "text" : "password"}
                value={newPassphrase}
                onChange={(e) => setNewPassphrase(e.target.value)}
                placeholder={t("newPassphrasePlaceholder")}
                autoComplete="new-password"
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowNew(!showNew)}
              >
                {showNew ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
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
                  {strength.labelKey ? t(strength.labelKey) : ""}
                </p>
              </div>
            )}
            {newPassphrase && newPassphrase.length < 10 && (
              <p className="text-xs text-destructive">
                {t("passphraseMinLength")}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cp-confirm">{t("confirmNewPassphrase")}</Label>
            <Input
              id="cp-confirm"
              type="password"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              placeholder={t("confirmNewPassphrasePlaceholder")}
              autoComplete="new-password"
              required
            />
            {confirmPassphrase && newPassphrase !== confirmPassphrase && (
              <p className="text-xs text-destructive">
                {t("passphraseMismatch")}
              </p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="submit"
              disabled={!isValid || loading}
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("changePassphraseButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
