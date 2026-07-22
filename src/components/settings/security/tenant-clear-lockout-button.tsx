"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { LockOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { handleStepUpError } from "@/lib/http/handle-step-up-error";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";

interface TenantClearLockoutButtonProps {
  userId: string;
  memberName: string;
  disabled?: boolean;
  onSuccess?: () => void;
}

export function TenantClearLockoutButton({
  userId,
  memberName,
  disabled,
  onSuccess,
}: TenantClearLockoutButtonProps) {
  const t = useTranslations("TenantAdmin");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Inline step-up reauth — on a stale session the confirm dialog stays open
  // and the hook re-runs handleClear after reauth.
  const inlineReauth = useInlineReauth(() => handleClear());

  const handleClear = async () => {
    setLoading(true);
    try {
      // @stepup id:clear-lockout-post
      const res = await fetchApi(
        apiPath.tenantMemberClearLockout(userId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      if (res.ok) {
        toast.success(t("clearLockoutSuccess"));
        setOpen(false);
        onSuccess?.();
        return;
      }
      if (await handleStepUpError(res, inlineReauth.triggerOnStaleError)) return;
      if (res.status === 429) {
        toast.error(t("clearLockoutRateLimited"));
      } else {
        toast.error(t("clearLockoutFailed"));
      }
    } catch {
      toast.error(t("clearLockoutFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={disabled}>
          <LockOpen className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("clearLockoutTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("clearLockoutDescription", { name: memberName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={handleClear} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("clearLockoutConfirm")}
          </AlertDialogAction>
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
