"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useVault } from "@/lib/vault/vault-context";
import { apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
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
import { Loader2, Eye, EyeOff, AlertTriangle } from "lucide-react";

interface RotateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RotateKeyDialog({ open, onOpenChange }: RotateKeyDialogProps) {
  const t = useTranslations("Vault");
  const tApi = useTranslations("ApiErrors");
  const { rotateKey } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progressPhase, setProgressPhase] = useState("");
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  // When the data fetch reports attachmentsAffected > 0, the user must
  // explicitly acknowledge that those attachments will become unreadable
  // post-rotation (Phase B will introduce per-attachment CEK indirection that
  // removes this trade-off — see plan #433 / A.4).
  const [attachmentsAffected, setAttachmentsAffected] = useState(0);

  function resetForm() {
    setPassphrase("");
    setShowPassphrase(false);
    setError("");
    setProgressPhase("");
    setProgressCurrent(0);
    setProgressTotal(0);
    setAttachmentsAffected(0);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function performRotation(acknowledgeAttachmentDataLoss?: boolean) {
    setLoading(true);
    setError("");
    try {
      await rotateKey(
        passphrase,
        (phase, current, total) => {
          setProgressPhase(phase);
          setProgressCurrent(current);
          setProgressTotal(total);
        },
        acknowledgeAttachmentDataLoss ? { acknowledgeAttachmentDataLoss: true } : undefined,
      );
      toast.success(t("rotateKeySuccess"));
      handleOpenChange(false);
    } catch (err: unknown) {
      const apiErr = err as { error?: string; attachmentsAffected?: number } | undefined;
      const errorCode = apiErr?.error;

      if (errorCode === "ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED") {
        // Surface the count and switch to the ack confirm step. The user
        // re-submits to retry with the flag set.
        setAttachmentsAffected(apiErr?.attachmentsAffected ?? 0);
      } else if (errorCode === "INVALID_PASSPHRASE") {
        setError(tApi("invalidPassphrase"));
      } else if (errorCode === "RATE_LIMIT_EXCEEDED") {
        setError(tApi("rateLimitExceeded"));
      } else if (errorCode === "ENTRY_COUNT_MISMATCH") {
        setError(tApi("entryCountMismatch"));
      } else if (errorCode) {
        setError(tApi(apiErrorToI18nKey(errorCode)));
      } else {
        setError(t("rotateKeyFailed"));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || loading) return;
    await performRotation();
  }

  async function handleAcknowledgeAndProceed() {
    if (loading) return;
    await performRotation(true);
  }

  const phaseLabel =
    progressPhase === "entries"
      ? t("rotateKeyProgressEntries")
      : progressPhase === "history"
        ? t("rotateKeyProgressHistory")
        : "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("rotateKey")}</DialogTitle>
          <DialogDescription>{t("rotateKeyDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("rotateKeyWarningEa")}</span>
          </div>
          <div className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
            {t("rotateKeyWarningTime")}
          </div>
        </div>
        <form
          onSubmit={handleSubmit}
          onKeyDown={preventIMESubmit}
          className="space-y-4 rounded-lg border bg-muted/20 p-4"
        >
          <div className="space-y-2">
            <Label htmlFor="rk-passphrase">{t("rotateKeyPassphrase")}</Label>
            <div className="relative">
              <Input
                id="rk-passphrase"
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("rotateKeyPassphrasePlaceholder")}
                autoComplete="current-password"
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

          {loading && phaseLabel && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{phaseLabel}</p>
              {progressTotal > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("rotateKeyProgress", {
                    current: progressCurrent,
                    total: progressTotal,
                  })}
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {attachmentsAffected > 0 && (
            <div className="flex flex-col gap-3 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("rotateKeyAttachmentDataLossWarning", { count: attachmentsAffected })}
                </span>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={loading}
                onClick={handleAcknowledgeAndProceed}
              >
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t("rotateKeyAttachmentAcknowledge")}
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button
              type="submit"
              disabled={!passphrase || loading || attachmentsAffected > 0}
              variant="destructive"
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("rotateKeyButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
