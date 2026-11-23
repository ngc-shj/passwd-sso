"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useTravelMode } from "@/hooks/use-travel-mode";
import { useVault } from "@/lib/vault/vault-context";
import { computePassphraseVerifier } from "@/lib/crypto/crypto-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plane, AlertTriangle } from "lucide-react";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { formatLockedUntil } from "@/components/vault/vault-lock-screen";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";

export function TravelModeCard() {
  const t = useTranslations("TravelMode");
  // The disable route shares the vault-unlock lockout, so its lockout copy
  // comes from the Vault namespace that formatLockedUntil reads; so do its
  // rate-limit and retry-later copies, as on the vault lock screen.
  const tVault = useTranslations("Vault");
  const tAuth = useTranslations("Auth");
  const travelMode = useTravelMode();
  const { active, loading, enable } = travelMode;
  const { getAccountSalt } = useVault();
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [disableError, setDisableError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const handleEnable = async () => {
    setBusy(true);
    const result = await enable();
    setBusy(false);
    setShowEnableConfirm(false);
    if (result.success) return;
    if (result.error === API_ERROR.UNAUTHORIZED) {
      // The session expired: retrying cannot succeed without a fresh sign-in.
      setSessionExpired(true);
    } else {
      toast.error(t("enableFailed"));
    }
  };

  const handleDisable = async () => {
    if (!passphrase.trim()) {
      setDisableError(t("passphraseRequired"));
      return;
    }

    setBusy(true);
    setDisableError(null);

    try {
      const accountSalt = getAccountSalt();
      if (!accountSalt) {
        setDisableError(t("disableFailed"));
        return;
      }
      const verifierHash = await computePassphraseVerifier(passphrase, accountSalt);
      const result = await travelMode.disable(verifierHash);
      if (result.success) {
        setShowDisableDialog(false);
        setPassphrase("");
      } else if (result.error === API_ERROR.INVALID_PASSPHRASE) {
        setDisableError(t("passphraseIncorrect"));
      } else if (result.error === API_ERROR.ACCOUNT_LOCKED) {
        setDisableError(formatLockedUntil(result.lockedUntil, tVault));
      } else if (result.error === API_ERROR.RATE_LIMIT_EXCEEDED) {
        setDisableError(tVault("rateLimited"));
      } else if (result.error === API_ERROR.SERVICE_UNAVAILABLE) {
        // The server could not check the passphrase (e.g. its verifier pepper
        // is not configured): the same passphrase may succeed on a retry.
        setDisableError(tVault("retryLater"));
      } else if (result.error === API_ERROR.UNAUTHORIZED) {
        // The session expired: no passphrase can succeed, so leave the
        // dialog for a fresh sign-in.
        handleDisableDialogChange(false);
        setSessionExpired(true);
      } else {
        setDisableError(t("disableFailed"));
      }
    } catch {
      setDisableError(t("disableFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Cancel calls this too: a controlled open change does not fire
  // onOpenChange, so a direct setter would keep the typed passphrase.
  const handleDisableDialogChange = (open: boolean) => {
    setShowDisableDialog(open);
    if (!open) {
      setPassphrase("");
      setDisableError(null);
    }
  };

  if (loading) return null;

  return (
    <>
      <Card>
        <SectionCardHeader icon={Plane} title={t("title")} description={t("description")} />
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{t("securityNote")}</span>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-muted-foreground">{t("status")}:</span>{" "}
              <span className="font-medium">
                {active ? t("active") : t("inactive")}
              </span>
            </div>
            {active ? (
              <Button
                variant="outline"
                onClick={() => setShowDisableDialog(true)}
              >
                {t("disable")}
              </Button>
            ) : (
              <Button
                variant="default"
                onClick={() => setShowEnableConfirm(true)}
              >
                {t("enable")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Enable Confirmation */}
      <AlertDialog open={showEnableConfirm} onOpenChange={setShowEnableConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("enable")}</AlertDialogTitle>
            <AlertDialogDescription>{t("enableConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleEnable} disabled={busy}>
              {t("enable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disable Dialog with passphrase */}
      <Dialog open={showDisableDialog} onOpenChange={handleDisableDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("disableTitle")}</DialogTitle>
            <DialogDescription>{t("disableDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="travel-passphrase">{t("passphrasePlaceholder")}</Label>
              <Input
                id="travel-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleDisable();
                  }
                }}
              />
            </div>
            {disableError && (
              <p className="text-sm text-destructive">{disableError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => handleDisableDialogChange(false)}
              >
                {t("cancel")}
              </Button>
              <Button onClick={handleDisable} disabled={busy}>
                {t("disable")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <RecentSessionRequiredDialog
        actionLabel={tAuth("recentSessionAction")}
        cancelLabel={t("cancel")}
        description={tAuth("reauthSessionExpired")}
        onOpenChange={setSessionExpired}
        open={sessionExpired}
        title={tAuth("recentSessionTitle")}
      />
    </>
  );
}
