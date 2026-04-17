"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BankAccountFields } from "@/components/entry-fields/bank-account-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";
import { useEntryHasChanges } from "@/hooks/use-entry-has-changes";

export function TeamBankAccountForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tba = useTranslations("BankAccountForm");
  const ttm = useTranslations("TravelMode");
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

  const hasChanges = useEntryHasChanges(
    () => ({
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
      travelSafe: base.travelSafe,
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
      base.travelSafe,
      base.expiresAt,
    ],
  );
  const submitDisabled = !base.title.trim();

  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const {
    tagsAndFolderProps,
    repromptSectionProps,
    travelSafeSectionProps,
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
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
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
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setTeamFolderId: base.setTeamFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setTravelSafe: base.setTravelSafe,
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
    <>
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
          <EntryTravelSafeSection {...travelSafeSectionProps} />
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
    </>
  );
}
