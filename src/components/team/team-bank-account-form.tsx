"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BankAccountFields } from "@/components/entry-fields/bank-account-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

export function TeamBankAccountForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamPasswordFormProps) {
  const tba = useTranslations("BankAccountForm");
  const base = useTeamBaseFormModel({
    teamId,
    open,
    onOpenChange,
    onSaved,
    entryType,
    editData,
    defaultFolderId,
    defaultTags,
  });

  // Entry-specific state
  const [bankName, setBankName] = useState(editData?.bankName ?? "");
  const [accountType, setAccountType] = useState(editData?.accountType ?? "");
  const [accountHolderName, setAccountHolderName] = useState(editData?.accountHolderName ?? "");
  const [accountNumber, setAccountNumber] = useState(editData?.accountNumber ?? "");
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [routingNumber, setRoutingNumber] = useState(editData?.routingNumber ?? "");
  const [showRoutingNumber, setShowRoutingNumber] = useState(false);
  const [swiftBic, setSwiftBic] = useState(editData?.swiftBic ?? "");
  const [iban, setIban] = useState(editData?.iban ?? "");
  const [branchName, setBranchName] = useState(editData?.branchName ?? "");

  // hasChanges
  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        bankName: editData?.bankName ?? "",
        accountType: editData?.accountType ?? "",
        accountHolderName: editData?.accountHolderName ?? "",
        accountNumber: editData?.accountNumber ?? "",
        routingNumber: editData?.routingNumber ?? "",
        swiftBic: editData?.swiftBic ?? "",
        iban: editData?.iban ?? "",
        branchName: editData?.branchName ?? "",
        selectedTagIds: (editData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        teamFolderId: editData?.teamFolderId ?? defaultFolderId ?? null,
        requireReprompt: editData?.requireReprompt ?? false,
        expiresAt: editData?.expiresAt ?? null,
      }),
    [editData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        notes: base.notes,
        bankName,
        accountType,
        accountHolderName,
        accountNumber,
        routingNumber,
        swiftBic,
        iban,
        branchName,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        teamFolderId: base.teamFolderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      base.notes,
      bankName,
      accountType,
      accountHolderName,
      accountNumber,
      routingNumber,
      swiftBic,
      iban,
      branchName,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = !base.title.trim();

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    repromptSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildTeamFormSectionsProps({
    teamId,
    tagsTitle: base.entryCopy.tagsTitle,
    tagsHint: base.t("tagsHint"),
    folders: base.teamFolders,
    sectionCardClass: dialogSectionClass,
    isLoginEntry: false,
    hasChanges,
    saving: base.saving,
    submitDisabled,
    saveLabel: base.isEdit ? base.tc("update") : base.tc("save"),
    cancelLabel: base.tc("cancel"),
    statusUnsavedLabel: base.t("statusUnsaved"),
    statusSavedLabel: base.t("statusSaved"),
    repromptTitle: base.t("requireReprompt"),
    repromptDescription: base.t("requireRepromptHelp"),
    repromptPolicyForced: base.teamPolicy?.requireRepromptForAll,
    repromptPolicyForcedLabel: base.teamPolicy?.requireRepromptForAll
      ? base.t("requireRepromptPolicyForced")
      : undefined,
    expirationTitle: base.t("expirationTitle"),
    expirationDescription: base.t("expirationDescription"),
    onCancel: () => base.handleOpenChange(false),
    values: {
      selectedTags: base.selectedTags,
      teamFolderId: base.teamFolderId,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: base.requireReprompt,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    const tagNames = base.selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await base.submitEntry({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: base.title,
      notes: base.notes,
      tagNames,
      bankName,
      accountType,
      accountHolderName,
      accountNumber,
      routingNumber,
      swiftBic,
      iban,
      branchName,
    });
  };

  return (
    <Dialog open={open} onOpenChange={base.handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{base.entryCopy.dialogLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            {base.entryCopy.dialogLabel}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleFormSubmit(e);
          }}
          onKeyDown={preventIMESubmit}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label>{base.entryCopy.titleLabel}</Label>
            <Input
              value={base.title}
              onChange={(e) => base.setTitle(e.target.value)}
              placeholder={base.entryCopy.titlePlaceholder}
            />
          </div>

          <BankAccountFields
            idPrefix="team-"
            bankName={bankName}
            onBankNameChange={setBankName}
            bankNamePlaceholder={tba("bankNamePlaceholder")}
            accountType={accountType}
            onAccountTypeChange={setAccountType}
            accountTypePlaceholder={tba("accountTypePlaceholder")}
            accountTypeCheckingLabel={tba("accountTypeChecking")}
            accountTypeSavingsLabel={tba("accountTypeSavings")}
            accountTypeOtherLabel={tba("accountTypeOther")}
            accountHolderName={accountHolderName}
            onAccountHolderNameChange={setAccountHolderName}
            accountHolderNamePlaceholder={tba("accountHolderNamePlaceholder")}
            accountNumber={accountNumber}
            onAccountNumberChange={setAccountNumber}
            accountNumberPlaceholder={tba("accountNumberPlaceholder")}
            showAccountNumber={showAccountNumber}
            onToggleAccountNumber={() => setShowAccountNumber(!showAccountNumber)}
            routingNumber={routingNumber}
            onRoutingNumberChange={setRoutingNumber}
            routingNumberPlaceholder={tba("routingNumberPlaceholder")}
            showRoutingNumber={showRoutingNumber}
            onToggleRoutingNumber={() => setShowRoutingNumber(!showRoutingNumber)}
            swiftBic={swiftBic}
            onSwiftBicChange={setSwiftBic}
            swiftBicPlaceholder={tba("swiftBicPlaceholder")}
            iban={iban}
            onIbanChange={setIban}
            ibanPlaceholder={tba("ibanPlaceholder")}
            branchName={branchName}
            onBranchNameChange={setBranchName}
            branchNamePlaceholder={tba("branchNamePlaceholder")}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            labels={{
              bankName: tba("bankName"),
              accountType: tba("accountType"),
              accountHolderName: tba("accountHolderName"),
              accountNumber: tba("accountNumber"),
              routingNumber: tba("routingNumber"),
              swiftBic: tba("swiftBic"),
              iban: tba("iban"),
              branchName: tba("branchName"),
            }}
          />

          <TeamTagsAndFolderSection {...tagsAndFolderProps} />
          <EntryRepromptSection {...repromptSectionProps} />
          <EntryExpirationSection {...expirationSectionProps} />
          <EntryActionBar {...actionBarProps} />
        </form>

        {base.isEdit && editData && (
          <div className="border-t pt-4">
            <TeamAttachmentSection
              teamId={teamId}
              entryId={editData.id}
              attachments={base.attachments}
              onAttachmentsChange={base.setAttachments}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
