"use client";

import { useTranslations } from "next-intl";
import { PasswordForm } from "./password-form";
import { SecureNoteForm } from "./secure-note-form";
import { CreditCardForm } from "./credit-card-form";
import { IdentityForm } from "./identity-form";
import { PasskeyForm } from "./passkey-form";
import { BankAccountForm } from "./bank-account-form";
import { SoftwareLicenseForm } from "./software-license-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { TagData } from "@/components/tags/tag-input";
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
  entryType?: EntryTypeValue;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function PasswordNewDialog({
  open,
  onOpenChange,
  onSaved,
  entryType = ENTRY_TYPE.LOGIN,
  defaultFolderId,
  defaultTags,
}: PasswordNewDialogProps) {
  const tp = useTranslations("PasswordForm");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");
  const tba = useTranslations("BankAccountForm");
  const tsl = useTranslations("SoftwareLicenseForm");

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = entryType === ENTRY_TYPE.SOFTWARE_LICENSE;

  const dialogTitle = isBankAccount
    ? tba("newBankAccount")
    : isSoftwareLicense
    ? tsl("newLicense")
    : isPasskey
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
        {isBankAccount ? (
          <BankAccountForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : isSoftwareLicense ? (
          <SoftwareLicenseForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : isPasskey ? (
          <PasskeyForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : isIdentity ? (
          <IdentityForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : isCreditCard ? (
          <CreditCardForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : isNote ? (
          <SecureNoteForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        ) : (
          <PasswordForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
