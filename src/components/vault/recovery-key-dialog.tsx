"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useVault } from "@/lib/vault-context";
import { computePassphraseVerifier } from "@/lib/crypto-client";
import {
  generateRecoveryKey,
  formatRecoveryKey,
  wrapSecretKeyWithRecovery,
} from "@/lib/crypto-recovery";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Copy, AlertTriangle } from "lucide-react";

interface RecoveryKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "passphrase" | "display";

export function RecoveryKeyDialog({
  open,
  onOpenChange,
}: RecoveryKeyDialogProps) {
  const t = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const { getSecretKey, getAccountSalt, hasRecoveryKey, setHasRecoveryKey } = useVault();

  const [step, setStep] = useState<Step>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [formattedKey, setFormattedKey] = useState("");
  const [savedConfirm, setSavedConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function resetForm() {
    setStep("passphrase");
    setPassphrase("");
    setFormattedKey("");
    setSavedConfirm(false);
    setError("");
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase) return;

    const secretKey = getSecretKey();
    const accountSalt = getAccountSalt();
    if (!secretKey || !accountSalt) {
      setError("Vault must be unlocked.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      // 1. Compute passphrase verifier for server-side confirmation
      const currentVerifierHash = await computePassphraseVerifier(
        passphrase,
        accountSalt,
      );

      // 2. Generate recovery key
      const recoveryKey = generateRecoveryKey();

      // 3. Wrap secretKey with recovery key
      const wrapped = await wrapSecretKeyWithRecovery(secretKey, recoveryKey);

      // 4. Send to server
      const res = await fetch(API_PATH.VAULT_RECOVERY_KEY_GENERATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentVerifierHash,
          encryptedSecretKey: wrapped.encryptedSecretKey,
          secretKeyIv: wrapped.iv,
          secretKeyAuthTag: wrapped.authTag,
          hkdfSalt: wrapped.hkdfSalt,
          verifierHash: wrapped.verifierHash,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === "INVALID_PASSPHRASE") {
          setError(tApi("invalidPassphrase"));
        } else if (err.error) {
          setError(tApi(apiErrorToI18nKey(err.error)));
        } else {
          setError(tApi("unknownError"));
        }
        return;
      }

      // 5. Format and display the recovery key
      const formatted = await formatRecoveryKey(recoveryKey);
      setFormattedKey(formatted);
      setStep("display");

      // Zero the recovery key from memory
      recoveryKey.fill(0);
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formattedKey);
      toast.success(t("recoveryKeyCopySuccess"));
    } catch {
      // Fallback: select text
    }
  }

  function handleClose() {
    setHasRecoveryKey(true);
    // Remove banner dismiss timestamp so banner won't re-show
    try {
      localStorage.removeItem("psso:recovery-key-banner-dismissed");
    } catch {
      // Ignore
    }
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("recoveryKeyDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("recoveryKeyDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "passphrase" && (
          <form onSubmit={handleGenerate} className="space-y-4 rounded-lg border bg-muted/20 p-4">
            {hasRecoveryKey && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{t("recoveryKeyRegenerateWarning")}</p>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              {t("recoveryKeyEnterPassphrase")}
            </p>

            <div className="space-y-2">
              <Label htmlFor="rk-passphrase">{t("currentPassphrase")}</Label>
              <Input
                id="rk-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("currentPassphrasePlaceholder")}
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={!passphrase || loading}>
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {loading ? t("recoveryKeyGenerating") : t("recoveryKey")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "display" && (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{t("recoveryKeyWarning")}</p>
            </div>

            <div className="relative rounded-md border bg-background p-3">
              <code className="block break-all font-mono text-sm leading-relaxed">
                {formattedKey}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 h-7 w-7"
                onClick={handleCopy}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="rk-saved"
                checked={savedConfirm}
                onCheckedChange={(checked) =>
                  setSavedConfirm(checked === true)
                }
              />
              <Label htmlFor="rk-saved" className="text-sm font-normal">
                {t("recoveryKeySavedConfirm")}
              </Label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                disabled={!savedConfirm}
                onClick={handleClose}
              >
                {t("recoveryKeyClose")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
