"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";

interface TenantVaultResetButtonProps {
  userId: string;
  memberName: string;
  disabled?: boolean;
  onSuccess?: () => void;
}

const CONFIRMATION_TEXT = "RESET";

export function TenantVaultResetButton({
  userId,
  memberName,
  disabled,
  onSuccess,
}: TenantVaultResetButtonProps) {
  const t = useTranslations("TenantAdmin");
  const [open, setOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [loading, setLoading] = useState(false);

  // Inline step-up reauth — initiate is server-side step-up-gated; on a stale
  // session the confirm dialog stays open and the hook re-runs initiate after
  // reauth.
  const inlineReauth = useInlineReauth(() => handleReset());

  const handleReset = async () => {
    setLoading(true);
    try {
      // @stepup id:reset-vault-post
      const res = await fetchApi(
        apiPath.tenantMemberResetVault(userId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      if (res.ok) {
        toast.success(t("vaultResetInitiated"));
        setOpen(false);
        setConfirmInput("");
        onSuccess?.();
      } else if (res.status === 429) {
        toast.error(t("vaultResetRateLimited"));
      } else if (res.status === 403) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
          await inlineReauth.triggerOnStaleError();
        } else {
          toast.error(t("vaultResetFailed"));
        }
      } else {
        toast.error(t("vaultResetFailed"));
      }
    } catch {
      toast.error(t("vaultResetFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setConfirmInput(""); }}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={disabled}>
          <RotateCcw className="h-4 w-4 text-destructive" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("vaultResetTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("vaultResetDescription", { name: memberName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 py-2">
          <p className="text-sm text-muted-foreground">
            {t("vaultResetConfirmHint", { text: CONFIRMATION_TEXT })}
          </p>
          <Input
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={CONFIRMATION_TEXT}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleReset}
            disabled={confirmInput !== CONFIRMATION_TEXT || loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("vaultResetConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>

      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        cancelLabel={t("cancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        cancelLabel={t("cancel")}
      />
    </AlertDialog>
  );
}
