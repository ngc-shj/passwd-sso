"use client";

import { useTranslations } from "next-intl";
import { PersonalLoginForm } from "./personal-login-form";
import { SecureNoteForm } from "./personal-secure-note-form";
import { CreditCardForm } from "./personal-credit-card-form";
import { IdentityForm } from "./personal-identity-form";
import { PasskeyForm } from "./personal-passkey-form";
import { BankAccountForm } from "./personal-bank-account-form";
import { SoftwareLicenseForm } from "./personal-software-license-form";
import { PersonalEntryDialogShell } from "./personal-entry-dialog-shell";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { TagData } from "@/components/tags/tag-input";

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
    <PersonalEntryDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
    >
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
          <PersonalLoginForm
            mode="create"
            variant="dialog"
            onSaved={handleSaved}
            defaultFolderId={defaultFolderId}
            defaultTags={defaultTags}
          />
        )}
    </PersonalEntryDialogShell>
  );
}
