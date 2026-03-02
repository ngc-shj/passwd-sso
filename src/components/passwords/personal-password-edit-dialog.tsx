"use client";

import { useTranslations } from "next-intl";
import { PersonalLoginForm } from "./personal-login-form";
import { SecureNoteForm } from "./personal-secure-note-form";
import { CreditCardForm } from "./personal-credit-card-form";
import { IdentityForm } from "./personal-identity-form";
import { PasskeyForm } from "./personal-passkey-form";
import { BankAccountForm } from "./personal-bank-account-form";
import { SoftwareLicenseForm } from "./personal-software-license-form";
import { AttachmentSection, type AttachmentMeta } from "./attachment-section";
import type { PersonalPasswordEditData } from "./personal-password-edit-dialog-types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ENTRY_TYPE } from "@/lib/constants";

interface PasswordEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editData: PersonalPasswordEditData;
  attachments: AttachmentMeta[];
  onAttachmentsChange: (attachments: AttachmentMeta[]) => void;
}

export function PasswordEditDialog({
  open,
  onOpenChange,
  onSaved,
  editData,
  attachments,
  onAttachmentsChange,
}: PasswordEditDialogProps) {
  const t = useTranslations("PasswordForm");
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

  const isNote = editData.entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = editData.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = editData.entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = editData.entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = editData.entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = editData.entryType === ENTRY_TYPE.SOFTWARE_LICENSE;

  const dialogTitle = isBankAccount
    ? tba("editBankAccount")
    : isSoftwareLicense
    ? tsl("editLicense")
    : isPasskey
    ? tpk("editPasskey")
    : isIdentity
      ? ti("editIdentity")
      : isCreditCard
      ? tcc("editCard")
      : isNote
        ? tn("editNote")
        : t("editPassword");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        {isBankAccount ? (
          <BankAccountForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              bankName: editData.bankName ?? null,
              accountType: editData.accountType ?? null,
              accountHolderName: editData.accountHolderName ?? null,
              accountNumber: editData.accountNumber ?? null,
              routingNumber: editData.routingNumber ?? null,
              swiftBic: editData.swiftBic ?? null,
              iban: editData.iban ?? null,
              branchName: editData.branchName ?? null,
              notes: editData.notes,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : isSoftwareLicense ? (
          <SoftwareLicenseForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              softwareName: editData.softwareName ?? null,
              licenseKey: editData.licenseKey ?? null,
              version: editData.version ?? null,
              licensee: editData.licensee ?? null,
              email: editData.email ?? null,
              purchaseDate: editData.purchaseDate ?? null,
              expirationDate: editData.expirationDate ?? null,
              notes: editData.notes,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : isPasskey ? (
          <PasskeyForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              relyingPartyId: editData.relyingPartyId ?? null,
              relyingPartyName: editData.relyingPartyName ?? null,
              username: editData.username || null,
              credentialId: editData.credentialId ?? null,
              creationDate: editData.creationDate ?? null,
              deviceInfo: editData.deviceInfo ?? null,
              notes: editData.notes || null,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : isIdentity ? (
          <IdentityForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              fullName: editData.fullName ?? null,
              address: editData.address ?? null,
              phone: editData.phone ?? null,
              email: editData.email ?? null,
              dateOfBirth: editData.dateOfBirth ?? null,
              nationality: editData.nationality ?? null,
              idNumber: editData.idNumber ?? null,
              issueDate: editData.issueDate ?? null,
              expiryDate: editData.expiryDate ?? null,
              notes: editData.notes,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : isCreditCard ? (
          <CreditCardForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              cardholderName: editData.cardholderName ?? null,
              cardNumber: editData.cardNumber ?? null,
              brand: editData.brand ?? null,
              expiryMonth: editData.expiryMonth ?? null,
              expiryYear: editData.expiryYear ?? null,
              cvv: editData.cvv ?? null,
              notes: editData.notes,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : isNote ? (
          <SecureNoteForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              content: editData.content,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
          />
        ) : (
          <PersonalLoginForm
            mode="edit"
            variant="dialog"
            initialData={editData}
            onSaved={handleSaved}
          />
        )}
        <div className="border-t pt-4 mt-2">
          <AttachmentSection
            entryId={editData.id}
            attachments={attachments}
            onAttachmentsChange={onAttachmentsChange}
            keyVersion={undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
