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
import { fetchApi, apiPath } from "@/lib/url-helpers";

interface AdminVaultResetButtonProps {
  teamId: string;
  memberId: string;
  memberName: string;
}

const CONFIRMATION_TEXT = "RESET";

export function AdminVaultResetButton({
  teamId,
  memberId,
  memberName,
}: AdminVaultResetButtonProps) {
  const t = useTranslations("Team");
  const [open, setOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleReset = async () => {
    setLoading(true);
    try {
      const res = await fetchApi(
        apiPath.teamMemberResetVault(teamId, memberId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      if (res.ok) {
        toast.success(t("vaultResetInitiated"));
        setOpen(false);
        setConfirmInput("");
      } else if (res.status === 429) {
        toast.error(t("vaultResetRateLimited"));
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
        <Button variant="ghost" size="icon" className="h-8 w-8">
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
    </AlertDialog>
  );
}
