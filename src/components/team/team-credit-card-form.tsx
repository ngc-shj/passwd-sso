"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CreditCardFields } from "@/components/entry-fields/credit-card-fields";
import { TeamTagsAndFolderSection } from "@/components/team/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ime-guard";
import { CARD_BRANDS } from "@/lib/credit-card";
import { handleTeamCardNumberChange } from "@/components/team/team-login-submit";
import { getTeamCardValidationState } from "@/components/team/team-credit-card-validation";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team-form-sections-props";

export function TeamCreditCardForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const tcc = useTranslations("CreditCardForm");
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
  const [cardholderName, setCardholderName] = useState(editData?.cardholderName ?? "");
  const [brand, setBrand] = useState(editData?.brand ?? "");
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(
    editData?.brand ? "manual" : "auto",
  );
  const [cardNumber, setCardNumber] = useState(editData?.cardNumber ?? "");
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [expiryMonth, setExpiryMonth] = useState(editData?.expiryMonth ?? "");
  const [expiryYear, setExpiryYear] = useState(editData?.expiryYear ?? "");
  const [cvv, setCvv] = useState(editData?.cvv ?? "");
  const [showCvv, setShowCvv] = useState(false);

  // Card validation
  const {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  } = getTeamCardValidationState(cardNumber, brand);

  const detectedBrand = cardValidation.detectedBrand
    ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
    : undefined;

  const effectiveHasBrandHint =
    hasBrandHint && cardValidation.digits.length > 0;

  const onCardNumberChange = (value: string) => {
    handleTeamCardNumberChange({
      value,
      brand,
      brandSource,
      setCardNumber,
      setBrand,
    });
  };

  // hasChanges
  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        cardholderName: editData?.cardholderName ?? "",
        brand: editData?.brand ?? "",
        cardNumber: editData?.cardNumber ?? "",
        expiryMonth: editData?.expiryMonth ?? "",
        expiryYear: editData?.expiryYear ?? "",
        cvv: editData?.cvv ?? "",
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
        cardholderName,
        brand,
        cardNumber,
        expiryMonth,
        expiryYear,
        cvv,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        teamFolderId: base.teamFolderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      base.notes,
      cardholderName,
      brand,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      base.selectedTags,
      base.teamFolderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = !base.title.trim() || !cardNumberValid;

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
      entryType: ENTRY_TYPE.CREDIT_CARD,
      title: base.title,
      notes: base.notes,
      tagNames,
      cardholderName,
      cardNumber,
      brand,
      expiryMonth,
      expiryYear,
      cvv,
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

          <CreditCardFields
            idPrefix="team-"
            cardholderName={cardholderName}
            onCardholderNameChange={setCardholderName}
            cardholderNamePlaceholder={tcc("cardholderNamePlaceholder")}
            brand={brand}
            onBrandChange={(v) => {
              setBrand(v);
              setBrandSource("manual");
            }}
            brandPlaceholder={tcc("brandPlaceholder")}
            brands={CARD_BRANDS}
            cardNumber={cardNumber}
            onCardNumberChange={onCardNumberChange}
            cardNumberPlaceholder={tcc("cardNumberPlaceholder")}
            showCardNumber={showCardNumber}
            onToggleCardNumber={() => setShowCardNumber(!showCardNumber)}
            maxInputLength={maxInputLength}
            showLengthError={showLengthError}
            showLuhnError={showLuhnError}
            detectedBrand={detectedBrand}
            hasBrandHint={effectiveHasBrandHint}
            lengthHintGenericLabel={tcc("cardNumberLengthHintGeneric")}
            lengthHintLabel={tcc("cardNumberLengthHint", { lengths: lengthHint })}
            invalidLengthLabel={tcc("cardNumberInvalidLength", { lengths: lengthHint })}
            invalidLuhnLabel={tcc("cardNumberInvalidLuhn")}
            expiryMonth={expiryMonth}
            onExpiryMonthChange={setExpiryMonth}
            expiryYear={expiryYear}
            onExpiryYearChange={setExpiryYear}
            expiryMonthPlaceholder={tcc("expiryMonth")}
            expiryYearPlaceholder={tcc("expiryYear")}
            cvv={cvv}
            onCvvChange={setCvv}
            cvvPlaceholder={tcc("cvvPlaceholder")}
            showCvv={showCvv}
            onToggleCvv={() => setShowCvv(!showCvv)}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            labels={{
              cardholderName: tcc("cardholderName"),
              brand: tcc("brand"),
              cardNumber: tcc("cardNumber"),
              expiry: tcc("expiry"),
              cvv: tcc("cvv"),
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
    </>
  );
}
