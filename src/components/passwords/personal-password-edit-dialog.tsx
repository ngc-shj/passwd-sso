"use client";

import { useTranslations } from "next-intl";
import { PersonalLoginForm } from "./personal-login-form";
import { SecureNoteForm } from "./personal-secure-note-form";
import { CreditCardForm } from "./personal-credit-card-form";
import { IdentityForm } from "./personal-identity-form";
import { PasskeyForm } from "./personal-passkey-form";
import { BankAccountForm } from "./personal-bank-account-form";
import { SoftwareLicenseForm } from "./personal-software-license-form";
import { SshKeyForm } from "./personal-ssh-key-form";
import { AttachmentSection, type AttachmentMeta } from "./entry/attachment-section";
import { PersonalEntryDialogShell } from "./personal-entry-dialog-shell";
import type { PersonalPasswordEditData } from "./personal-password-edit-dialog-types";
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
  const tsk = useTranslations("SshKeyForm");

  const handleSaved = () => {
    onOpenChange(false);
    onSaved();
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const isNote = editData.entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = editData.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = editData.entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = editData.entryType === ENTRY_TYPE.PASSKEY;
  const isBankAccount = editData.entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = editData.entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const isSshKey = editData.entryType === ENTRY_TYPE.SSH_KEY;

  const dialogTitle = isSshKey
    ? tsk("editSshKey")
    : isBankAccount
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
    <PersonalEntryDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
    >
        {isSshKey ? (
          <SshKeyForm
            mode="edit"
            variant="dialog"
            initialData={{
              id: editData.id,
              title: editData.title,
              privateKey: editData.privateKey ?? null,
              publicKey: editData.publicKey ?? null,
              keyType: editData.keyType ?? null,
              keySize: editData.keySize ?? null,
              fingerprint: editData.fingerprint ?? null,
              passphrase: editData.passphrase ?? null,
              comment: editData.sshComment ?? null,
              notes: editData.notes,
              tags: editData.tags,
              folderId: editData.folderId ?? null,
              requireReprompt: editData.requireReprompt ?? false,
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
          />
        ) : isBankAccount ? (
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
              passkeyPrivateKeyJwk: editData.passkeyPrivateKeyJwk ?? null,
              passkeyPublicKeyCose: editData.passkeyPublicKeyCose ?? null,
              passkeyUserHandle: editData.passkeyUserHandle ?? null,
              passkeyUserDisplayName: editData.passkeyUserDisplayName ?? null,
              passkeySignCount: editData.passkeySignCount ?? null,
              passkeyAlgorithm: editData.passkeyAlgorithm ?? null,
              passkeyTransports: editData.passkeyTransports ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
              travelSafe: editData.travelSafe ?? true,
              expiresAt: editData.expiresAt ?? null,
            }}
            onSaved={handleSaved}
            onCancel={handleCancel}
          />
        ) : (
          <PersonalLoginForm
            mode="edit"
            variant="dialog"
            initialData={editData}
            onSaved={handleSaved}
            onCancel={handleCancel}
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
    </PersonalEntryDialogShell>
  );
}
