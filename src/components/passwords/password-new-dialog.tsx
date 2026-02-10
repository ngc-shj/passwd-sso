"use client";

import { useTranslations } from "next-intl";
import { PasswordForm } from "./password-form";
import { SecureNoteForm } from "./secure-note-form";
import { CreditCardForm } from "./credit-card-form";
import { IdentityForm } from "./identity-form";
import { PasskeyForm } from "./passkey-form";
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
  entryType?: "LOGIN" | "SECURE_NOTE" | "CREDIT_CARD" | "IDENTITY" | "PASSKEY";
}

export function PasswordNewDialog({
  open,
  onOpenChange,
  onSaved,
  entryType = "LOGIN",
}: PasswordNewDialogProps) {
  const tp = useTranslations("PasswordForm");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  const isNote = entryType === "SECURE_NOTE";
  const isCreditCard = entryType === "CREDIT_CARD";
  const isIdentity = entryType === "IDENTITY";
  const isPasskey = entryType === "PASSKEY";

  const dialogTitle = isPasskey
    ? tpk("newPasskey")
    : isIdentity
      ? ti("newIdentity")
      : isCreditCard
      ? tcc("newCard")
      : isNote
        ? tn("newNote")
        : tp("newPassword");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        {isPasskey ? (
          <PasskeyForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
          />
        ) : isIdentity ? (
          <IdentityForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
          />
        ) : isCreditCard ? (
          <CreditCardForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
          />
        ) : isNote ? (
          <SecureNoteForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
          />
        ) : (
          <PasswordForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
