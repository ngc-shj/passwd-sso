"use client";

import { ENTRY_TYPE } from "@/lib/constants";
import { getTeamEntryKindState } from "@/components/team/forms/team-entry-kind";
import { buildTeamEntryCopy } from "@/components/team/forms/team-entry-copy";
import { buildTeamEntryCopyData } from "@/components/team/forms/team-entry-copy-data";
import { TeamEntryDialogShell } from "@/components/team/forms/team-entry-dialog-shell";
import type { TeamEntryFormEditData } from "@/components/team/forms/team-entry-form-types";
import type { TeamTagData } from "@/components/team/forms/team-tag-input";
import { TeamLoginForm } from "@/components/team/forms/team-login-form";
import { TeamSecureNoteForm } from "@/components/team/forms/team-secure-note-form";
import { TeamCreditCardForm } from "@/components/team/forms/team-credit-card-form";
import { TeamIdentityForm } from "@/components/team/forms/team-identity-form";
import { TeamPasskeyForm } from "@/components/team/forms/team-passkey-form";
import { TeamBankAccountForm } from "@/components/team/forms/team-bank-account-form";
import { TeamSoftwareLicenseForm } from "@/components/team/forms/team-software-license-form";
import { TeamSshKeyForm } from "@/components/team/forms/team-ssh-key-form";
import {
  toTeamLoginFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/form/use-entry-form-translations";

interface TeamEditDialogProps {
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editData: TeamEntryFormEditData;
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
  const translations = toTeamLoginFormTranslations(useEntryFormTranslations());
  const dialogTitle = buildTeamEntryCopy({
    isEdit: true,
    entryKind: getTeamEntryKindState(editData.entryType ?? ENTRY_TYPE.LOGIN).entryKind,
    copyByKind: buildTeamEntryCopyData(translations),
  }).dialogLabel;
  const shared = {
    teamId,
    open,
    onOpenChange,
    onSaved,
    editData,
    defaultFolderId,
    defaultTags,
  };

  let form = <TeamLoginForm {...shared} />;

  switch (editData.entryType) {
    case ENTRY_TYPE.SECURE_NOTE:
      form = <TeamSecureNoteForm {...shared} />;
      break;
    case ENTRY_TYPE.CREDIT_CARD:
      form = <TeamCreditCardForm {...shared} />;
      break;
    case ENTRY_TYPE.IDENTITY:
      form = <TeamIdentityForm {...shared} />;
      break;
    case ENTRY_TYPE.PASSKEY:
      form = <TeamPasskeyForm {...shared} />;
      break;
    case ENTRY_TYPE.BANK_ACCOUNT:
      form = <TeamBankAccountForm {...shared} />;
      break;
    case ENTRY_TYPE.SOFTWARE_LICENSE:
      form = <TeamSoftwareLicenseForm {...shared} />;
      break;
    case ENTRY_TYPE.SSH_KEY:
      form = <TeamSshKeyForm {...shared} />;
      break;
    case ENTRY_TYPE.LOGIN:
    default:
      break;
  }

  return (
    <TeamEntryDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
    >
      {form}
    </TeamEntryDialogShell>
  );
}
