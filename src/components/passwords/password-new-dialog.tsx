"use client";

import { useTranslations } from "next-intl";
import { PasswordForm } from "./password-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PasswordNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function PasswordNewDialog({
  open,
  onOpenChange,
  onSaved,
}: PasswordNewDialogProps) {
  const t = useTranslations("PasswordForm");

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("newPassword")}</DialogTitle>
        </DialogHeader>
        <PasswordForm
          mode="create"
          variant="dialog"
          onSaved={handleSaved}
        />
      </DialogContent>
    </Dialog>
  );
}
