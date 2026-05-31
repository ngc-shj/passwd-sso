"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IdentityFields } from "@/components/entry-fields/identity-fields";
import { TeamTagsAndFolderSection } from "@/components/team/forms/team-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry/entry-expiration-section";
import { TeamAttachmentSection } from "./team-attachment-section";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry/entry-form-ui";
import type { TeamEntryFormProps } from "@/components/team/forms/team-entry-form-types";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { toISODateString } from "@/lib/format/format-datetime";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamBaseFormModel } from "@/hooks/team/use-team-base-form-model";
import { buildTeamFormSectionsProps } from "@/hooks/team/team-form-sections-props";
import { useEntryHasChanges } from "@/hooks/form/use-entry-has-changes";

export function TeamIdentityForm({
  teamId,
  open,
  onOpenChange,
  onSaved,
  entryType,
  editData,
  defaultFolderId,
  defaultTags,
}: TeamEntryFormProps) {
  const ti = useTranslations("IdentityForm");
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
  const [fullName, setFullName] = useState(editData?.fullName ?? "");
  const [address, setAddress] = useState(editData?.address ?? "");
  const [givenName, setGivenName] = useState(editData?.givenName ?? "");
  const [familyName, setFamilyName] = useState(editData?.familyName ?? "");
  const [middleName, setMiddleName] = useState(editData?.middleName ?? "");
  const [familyNameKana, setFamilyNameKana] = useState(editData?.familyNameKana ?? "");
  const [givenNameKana, setGivenNameKana] = useState(editData?.givenNameKana ?? "");
  const [addressLine1, setAddressLine1] = useState(editData?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(editData?.addressLine2 ?? "");
  const [city, setCity] = useState(editData?.city ?? "");
  const [state, setState] = useState(editData?.state ?? "");
  const [postalCode, setPostalCode] = useState(editData?.postalCode ?? "");
  const [country, setCountry] = useState(editData?.country ?? "");
  const [phone, setPhone] = useState(editData?.phone ?? "");
  const [email, setEmail] = useState(editData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(editData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(editData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(editData?.idNumber ?? "");
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [issueDate, setIssueDate] = useState(editData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(editData?.expiryDate ?? "");
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  const hasChanges = useEntryHasChanges(
    () => ({
      title: base.title,
      notes: base.notes,
      fullName,
      address,
      givenName,
      familyName,
      middleName,
      familyNameKana,
      givenNameKana,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
      selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
      teamFolderId: base.teamFolderId,
      requireReprompt: base.requireReprompt,
      travelSafe: base.travelSafe,
      expiresAt: base.expiresAt,
    }),
    [
      base.title,
      base.notes,
      fullName,
      address,
      givenName,
      familyName,
      middleName,
      familyNameKana,
      givenNameKana,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
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

    const today = toISODateString();
    if (dateOfBirth && dateOfBirth > today) {
      setDobError(ti("dobFuture"));
      return;
    }
    setDobError(null);

    if (issueDate && expiryDate && issueDate >= expiryDate) {
      setExpiryError(ti("expiryBeforeIssue"));
      return;
    }
    setExpiryError(null);

    const tagNames = base.selectedTags.map((tag) => ({
      name: tag.name,
      color: tag.color,
    }));

    await base.submitEntry({
      entryType: ENTRY_TYPE.IDENTITY,
      title: base.title,
      notes: base.notes,
      tagNames,
      fullName,
      address,
      givenName,
      familyName,
      middleName,
      familyNameKana,
      givenNameKana,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
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

          <IdentityFields
            idPrefix="team-"
            fullName={fullName}
            onFullNameChange={setFullName}
            fullNamePlaceholder={ti("fullNamePlaceholder")}
            address={address}
            onAddressChange={setAddress}
            addressPlaceholder={ti("addressPlaceholder")}
            givenName={givenName}
            onGivenNameChange={setGivenName}
            givenNamePlaceholder={ti("givenNamePlaceholder")}
            familyName={familyName}
            onFamilyNameChange={setFamilyName}
            familyNamePlaceholder={ti("familyNamePlaceholder")}
            middleName={middleName}
            onMiddleNameChange={setMiddleName}
            middleNamePlaceholder={ti("middleNamePlaceholder")}
            familyNameKana={familyNameKana}
            onFamilyNameKanaChange={setFamilyNameKana}
            familyNameKanaPlaceholder={ti("familyNameKanaPlaceholder")}
            givenNameKana={givenNameKana}
            onGivenNameKanaChange={setGivenNameKana}
            givenNameKanaPlaceholder={ti("givenNameKanaPlaceholder")}
            addressLine1={addressLine1}
            onAddressLine1Change={setAddressLine1}
            addressLine1Placeholder={ti("addressLine1Placeholder")}
            addressLine2={addressLine2}
            onAddressLine2Change={setAddressLine2}
            addressLine2Placeholder={ti("addressLine2Placeholder")}
            city={city}
            onCityChange={setCity}
            cityPlaceholder={ti("cityPlaceholder")}
            state={state}
            onStateChange={setState}
            statePlaceholder={ti("statePlaceholder")}
            postalCode={postalCode}
            onPostalCodeChange={setPostalCode}
            postalCodePlaceholder={ti("postalCodePlaceholder")}
            country={country}
            onCountryChange={setCountry}
            countryPlaceholder={ti("countryPlaceholder")}
            phone={phone}
            onPhoneChange={setPhone}
            phonePlaceholder={ti("phonePlaceholder")}
            email={email}
            onEmailChange={setEmail}
            emailPlaceholder={ti("emailPlaceholder")}
            dateOfBirth={dateOfBirth}
            onDateOfBirthChange={(v) => {
              setDateOfBirth(v);
              setDobError(null);
            }}
            nationality={nationality}
            onNationalityChange={setNationality}
            nationalityPlaceholder={ti("nationalityPlaceholder")}
            idNumber={idNumber}
            onIdNumberChange={setIdNumber}
            idNumberPlaceholder={ti("idNumberPlaceholder")}
            showIdNumber={showIdNumber}
            onToggleIdNumber={() => setShowIdNumber(!showIdNumber)}
            issueDate={issueDate}
            onIssueDateChange={(v) => {
              setIssueDate(v);
              setExpiryError(null);
            }}
            expiryDate={expiryDate}
            onExpiryDateChange={(v) => {
              setExpiryDate(v);
              setExpiryError(null);
            }}
            dobError={dobError}
            expiryError={expiryError}
            notesLabel={base.entryCopy.notesLabel}
            notes={base.notes}
            onNotesChange={base.setNotes}
            notesPlaceholder={base.entryCopy.notesPlaceholder}
            labels={{
              fullName: ti("fullName"),
              address: ti("address"),
              givenName: ti("givenName"),
              familyName: ti("familyName"),
              middleName: ti("middleName"),
              familyNameKana: ti("familyNameKana"),
              givenNameKana: ti("givenNameKana"),
              addressLine1: ti("addressLine1"),
              addressLine2: ti("addressLine2"),
              city: ti("city"),
              state: ti("state"),
              postalCode: ti("postalCode"),
              country: ti("country"),
              nameGroup: ti("nameGroup"),
              addressGroup: ti("addressGroup"),
              phone: ti("phone"),
              email: ti("email"),
              dateOfBirth: ti("dateOfBirth"),
              nationality: ti("nationality"),
              idNumber: ti("idNumber"),
              issueDate: ti("issueDate"),
              expiryDate: ti("expiryDate"),
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
