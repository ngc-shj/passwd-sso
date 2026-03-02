"use client";

import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamPasswordFormEditData } from "@/components/team/team-password-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { TeamPasswordForm } from "@/components/team/team-password-form";
import { TeamSecureNoteForm } from "@/components/team/team-secure-note-form";
import { TeamCreditCardForm } from "@/components/team/team-credit-card-form";
import { TeamIdentityForm } from "@/components/team/team-identity-form";
import { TeamPasskeyForm } from "@/components/team/team-passkey-form";
import { TeamBankAccountForm } from "@/components/team/team-bank-account-form";
import { TeamSoftwareLicenseForm } from "@/components/team/team-software-license-form";

interface TeamEditDialogProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editData: TeamPasswordFormEditData;
  defaultFolderId?: string | null;
  defaultTags?: TeamTagData[];
}

export function TeamEditDialog({
  teamId,
  open,
  onOpenChange,
  onSaved,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEditDialogProps) {
  const shared = {
    teamId,
    open,
    onOpenChange,
    onSaved,
    editData,
    defaultFolderId,
    defaultTags,
  };

  switch (editData.entryType) {
    case ENTRY_TYPE.SECURE_NOTE:
      return <TeamSecureNoteForm {...shared} />;
    case ENTRY_TYPE.CREDIT_CARD:
      return <TeamCreditCardForm {...shared} />;
    case ENTRY_TYPE.IDENTITY:
      return <TeamIdentityForm {...shared} />;
    case ENTRY_TYPE.PASSKEY:
      return <TeamPasskeyForm {...shared} />;
    case ENTRY_TYPE.BANK_ACCOUNT:
      return <TeamBankAccountForm {...shared} />;
    case ENTRY_TYPE.SOFTWARE_LICENSE:
      return <TeamSoftwareLicenseForm {...shared} />;
    case ENTRY_TYPE.LOGIN:
    default:
      return <TeamPasswordForm {...shared} />;
  }
}
