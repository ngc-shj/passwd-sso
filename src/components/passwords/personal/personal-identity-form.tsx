"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { IdentityFields } from "@/components/entry-fields/identity-fields";
import {
  EntryActionBar,
  EntryPrimaryCard,
  ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry/entry-form-ui";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry/entry-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry/entry-expiration-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { composeIdentityNameLabel } from "@/lib/constants/identity-fields";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { toISODateString } from "@/lib/format/format-datetime";
import { toTagPayload } from "@/components/passwords/entry/entry-form-tags";
import { buildPersonalFormSectionsProps } from "@/hooks/personal/personal-form-sections-props";
import { usePersonalBaseFormModel } from "@/hooks/personal/use-personal-base-form-model";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { useEntryHasChanges } from "@/hooks/form/use-entry-has-changes";

interface IdentityFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    fullName: string | null;
    address: string | null;
    givenName?: string | null;
    familyName?: string | null;
    middleName?: string | null;
    familyNameKana?: string | null;
    givenNameKana?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
    phone: string | null;
    email: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    idNumber: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    notes: string | null;
    tags: TagData[];
    folderId?: string | null;
    requireReprompt?: boolean;
    travelSafe?: boolean;
    expiresAt?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
  onCancel?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function IdentityForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  onCancel,
  defaultFolderId,
  defaultTags,
}: IdentityFormProps) {
  const t = useTranslations("IdentityForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const ttm = useTranslations("TravelMode");
  const base = usePersonalBaseFormModel({
    mode,
    initialId: initialData?.id,
    initialTitle: initialData?.title,
    initialTags: initialData?.tags,
    initialFolderId: initialData?.folderId,
    initialRequireReprompt: initialData?.requireReprompt,
    initialExpiresAt: initialData?.expiresAt,
    defaultFolderId,
    defaultTags,
    variant,
    onSaved,
    onCancel,
  });
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [fullName, setFullName] = useState(initialData?.fullName ?? "");
  const [address, setAddress] = useState(initialData?.address ?? "");
  const [givenName, setGivenName] = useState(initialData?.givenName ?? "");
  const [familyName, setFamilyName] = useState(initialData?.familyName ?? "");
  const [middleName, setMiddleName] = useState(initialData?.middleName ?? "");
  const [familyNameKana, setFamilyNameKana] = useState(initialData?.familyNameKana ?? "");
  const [givenNameKana, setGivenNameKana] = useState(initialData?.givenNameKana ?? "");
  const [addressLine1, setAddressLine1] = useState(initialData?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(initialData?.addressLine2 ?? "");
  const [city, setCity] = useState(initialData?.city ?? "");
  const [state, setState] = useState(initialData?.state ?? "");
  const [postalCode, setPostalCode] = useState(initialData?.postalCode ?? "");
  const [country, setCountry] = useState(initialData?.country ?? "");
  const [phone, setPhone] = useState(initialData?.phone ?? "");
  const [email, setEmail] = useState(initialData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(initialData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(initialData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(initialData?.idNumber ?? "");
  const [issueDate, setIssueDate] = useState(initialData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(initialData?.expiryDate ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [travelSafe, setTravelSafe] = useState(initialData?.travelSafe ?? true);

  const hasChanges = useEntryHasChanges(
    () => ({
      title: base.title,
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
      notes,
      selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
      folderId: base.folderId,
      requireReprompt: base.requireReprompt,
      travelSafe,
      expiresAt: base.expiresAt,
    }),
    [
      base.title,
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
      notes,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      travelSafe,
      base.expiresAt,
    ],
  );
  useBeforeUnloadGuard(!base.isDialogVariant && hasChanges);
  const primaryCardClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS
    : "";
  const dialogSectionClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_SECTION_CLASS
    : "";
  const {
    tagsAndFolderProps,
    repromptSectionProps,
    travelSafeSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildPersonalFormSectionsProps({
    tagsTitle: t("tags"),
    tagsHint: tPw("tagsHint"),
    folders: base.folders,
    sectionCardClass: dialogSectionClass,
    repromptTitle: tPw("requireReprompt"),
    repromptDescription: tPw("requireRepromptHelp"),
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
    expirationTitle: tPw("expirationTitle"),
    expirationDescription: tPw("expirationDescription"),
    hasChanges,
    submitting: base.submitting,
    saveLabel: mode === "create" ? tc("save") : tc("update"),
    cancelLabel: tc("cancel"),
    statusUnsavedLabel: tPw("statusUnsaved"),
    statusSavedLabel: tPw("statusSaved"),
    onCancel: base.handleCancel,
    values: {
      selectedTags: base.selectedTags,
      folderId: base.folderId,
      customFields: [],
      totp: null,
      showTotpInput: false,
      requireReprompt: base.requireReprompt,
      travelSafe,
      expiresAt: base.expiresAt,
    },
    setters: {
      setSelectedTags: base.setSelectedTags,
      setFolderId: base.setFolderId,
      setCustomFields: () => {},
      setTotp: () => {},
      setShowTotpInput: () => {},
      setRequireReprompt: base.setRequireReprompt,
      setTravelSafe,
      setExpiresAt: base.setExpiresAt,
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let hasError = false;
    if (dateOfBirth && dateOfBirth > toISODateString()) {
      setDobError(t("dobFuture"));
      hasError = true;
    } else {
      setDobError(null);
    }

    if (issueDate && expiryDate && issueDate >= expiryDate) {
      setExpiryError(t("expiryBeforeIssue"));
      hasError = true;
    } else {
      setExpiryError(null);
    }

    if (hasError) return;

    const tags = toTagPayload(base.selectedTags);
    const idNumberLast4 = idNumber ? idNumber.slice(-4) : null;

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        fullName: fullName || null,
        address: address || null,
        givenName: givenName || null,
        familyName: familyName || null,
        middleName: middleName || null,
        familyNameKana: familyNameKana || null,
        givenNameKana: givenNameKana || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        state: state || null,
        postalCode: postalCode || null,
        country: country || null,
        phone: phone || null,
        email: email || null,
        dateOfBirth: dateOfBirth || null,
        nationality: nationality || null,
        idNumber: idNumber || null,
        issueDate: issueDate || null,
        expiryDate: expiryDate || null,
        notes: notes || null,
        tags,
        travelSafe,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        // Compose from structured given/family when fullName is absent. Address
        // PII stays out of the overview (encrypted fullBlob only).
        fullName: composeIdentityNameLabel(fullName, givenName, familyName),
        email: email || null,
        idNumberLast4,
        tags,
        travelSafe,
      }),
      entryType: ENTRY_TYPE.IDENTITY,
    });
  };

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      <EntryPrimaryCard className={primaryCardClass}>
        <div className="space-y-2">
          <Label htmlFor="title">{t("title")}</Label>
          <Input
            id="title"
            value={base.title}
            onChange={(e) => base.setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            required
          />
        </div>

        <IdentityFields
          fullName={fullName}
          onFullNameChange={setFullName}
          fullNamePlaceholder={t("fullNamePlaceholder")}
          address={address}
          onAddressChange={setAddress}
          addressPlaceholder={t("addressPlaceholder")}
          givenName={givenName}
          onGivenNameChange={setGivenName}
          givenNamePlaceholder={t("givenNamePlaceholder")}
          familyName={familyName}
          onFamilyNameChange={setFamilyName}
          familyNamePlaceholder={t("familyNamePlaceholder")}
          middleName={middleName}
          onMiddleNameChange={setMiddleName}
          middleNamePlaceholder={t("middleNamePlaceholder")}
          familyNameKana={familyNameKana}
          onFamilyNameKanaChange={setFamilyNameKana}
          familyNameKanaPlaceholder={t("familyNameKanaPlaceholder")}
          givenNameKana={givenNameKana}
          onGivenNameKanaChange={setGivenNameKana}
          givenNameKanaPlaceholder={t("givenNameKanaPlaceholder")}
          addressLine1={addressLine1}
          onAddressLine1Change={setAddressLine1}
          addressLine1Placeholder={t("addressLine1Placeholder")}
          addressLine2={addressLine2}
          onAddressLine2Change={setAddressLine2}
          addressLine2Placeholder={t("addressLine2Placeholder")}
          city={city}
          onCityChange={setCity}
          cityPlaceholder={t("cityPlaceholder")}
          state={state}
          onStateChange={setState}
          statePlaceholder={t("statePlaceholder")}
          postalCode={postalCode}
          onPostalCodeChange={setPostalCode}
          postalCodePlaceholder={t("postalCodePlaceholder")}
          country={country}
          onCountryChange={setCountry}
          countryPlaceholder={t("countryPlaceholder")}
          phone={phone}
          onPhoneChange={setPhone}
          phonePlaceholder={t("phonePlaceholder")}
          email={email}
          onEmailChange={setEmail}
          emailPlaceholder={t("emailPlaceholder")}
          dateOfBirth={dateOfBirth}
          onDateOfBirthChange={(v) => {
            setDateOfBirth(v);
            setDobError(null);
          }}
          nationality={nationality}
          onNationalityChange={setNationality}
          nationalityPlaceholder={t("nationalityPlaceholder")}
          idNumber={idNumber}
          onIdNumberChange={setIdNumber}
          idNumberPlaceholder={t("idNumberPlaceholder")}
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
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          labels={{
            fullName: t("fullName"),
            address: t("address"),
            givenName: t("givenName"),
            familyName: t("familyName"),
            middleName: t("middleName"),
            familyNameKana: t("familyNameKana"),
            givenNameKana: t("givenNameKana"),
            addressLine1: t("addressLine1"),
            addressLine2: t("addressLine2"),
            city: t("city"),
            state: t("state"),
            postalCode: t("postalCode"),
            country: t("country"),
            nameGroup: t("nameGroup"),
            addressGroup: t("addressGroup"),
            phone: t("phone"),
            email: t("email"),
            dateOfBirth: t("dateOfBirth"),
            nationality: t("nationality"),
            idNumber: t("idNumber"),
            issueDate: t("issueDate"),
            expiryDate: t("expiryDate"),
          }}
        />
      </EntryPrimaryCard>

      <EntryTagsAndFolderSection {...tagsAndFolderProps} />
      <EntryRepromptSection {...repromptSectionProps} />
      <EntryTravelSafeSection {...travelSafeSectionProps} />
      <EntryExpirationSection {...expirationSectionProps} />
      <EntryActionBar {...actionBarProps} />
    </form>
  );

  if (base.isDialogVariant) {
    return formContent;
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <Button variant="ghost" className="mb-4 gap-2" onClick={base.handleBack}>
          <ArrowLeft className="h-4 w-4" />
          {tc("back")}
        </Button>

        <Card className="rounded-xl border">
          <CardHeader>
            <CardTitle>{mode === "create" ? t("newIdentity") : t("editIdentity")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
