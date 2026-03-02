"use client";

import { ENTRY_TYPE } from "@/lib/constants";
import { getTeamEntryKindState } from "@/components/team/team-entry-kind";
import { buildTeamEntryCopy } from "@/components/team/team-entry-copy";
import { buildTeamEntryCopyData } from "@/components/team/team-entry-copy-data";
import { TeamEntryDialogShell } from "@/components/team/team-entry-dialog-shell";
import type { TeamPasswordFormEditData } from "@/components/team/team-password-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { TeamPasswordForm } from "@/components/team/team-password-form";
import { TeamSecureNoteForm } from "@/components/team/team-secure-note-form";
import { TeamCreditCardForm } from "@/components/team/team-credit-card-form";
import { TeamIdentityForm } from "@/components/team/team-identity-form";
import { TeamPasskeyForm } from "@/components/team/team-passkey-form";
import { TeamBankAccountForm } from "@/components/team/team-bank-account-form";
import { TeamSoftwareLicenseForm } from "@/components/team/team-software-license-form";
import {
  toTeamPasswordFormTranslations,
  useEntryFormTranslations,
} from "@/hooks/use-entry-form-translations";

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
  const translations = toTeamPasswordFormTranslations(useEntryFormTranslations());
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

  let form = <TeamPasswordForm {...shared} />;

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
