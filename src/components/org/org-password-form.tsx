"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import type { OrgTagData } from "./org-tag-input";
import { OrgAttachmentSection } from "./org-attachment-section";
import { getOrgCardValidationState } from "@/components/org/org-credit-card-validation";
import { buildOrgEntryCopy } from "@/components/org/org-entry-copy";
import { buildOrgEntryCopyData } from "@/components/org/org-entry-copy-data";
import { getOrgEntryKindState } from "@/components/org/org-entry-kind";
import { OrgEntrySpecificFields } from "@/components/org/org-entry-specific-fields";
import {
  type OrgPasswordFormSetters,
} from "@/components/org/org-password-form-state";
import { OrgTagsAndFolderSection } from "@/components/org/org-tags-and-folder-section";
import type {
  OrgPasswordFormProps,
} from "@/components/org/org-password-form-types";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  EntryActionBar,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { detectCardBrand, formatCardNumber, normalizeCardBrand, normalizeCardNumber } from "@/lib/credit-card";
import {
  extractTagIds,
} from "@/lib/entry-form-helpers";
import { buildOrgEntryPayload } from "@/lib/org-entry-payload";
import { validateOrgEntryBeforeSubmit } from "@/lib/org-entry-validation";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import { buildGeneratorSummary } from "@/lib/generator-summary";
import { executeOrgEntrySubmit } from "@/components/org/org-entry-submit";
import { useOrgFolders } from "@/hooks/use-org-folders";
import { useOrgAttachments } from "@/hooks/use-org-attachments";
import { useOrgEntrySpecificFieldsProps } from "@/hooks/use-org-entry-specific-fields-props";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";

export function OrgPasswordForm({
  orgId,
  open,
  onOpenChange,
  onSaved,
  entryType: entryTypeProp = ENTRY_TYPE.LOGIN,
  editData,
}: OrgPasswordFormProps) {
  const t = useTranslations("PasswordForm");
  const tGen = useTranslations("PasswordGenerator");
  const tn = useTranslations("SecureNoteForm");
  const tcc = useTranslations("CreditCardForm");
  const ti = useTranslations("IdentityForm");
  const tpk = useTranslations("PasskeyForm");
  const tc = useTranslations("Common");
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const { entryKind, isNote, isCreditCard, isIdentity, isPasskey, isLoginEntry } =
    getOrgEntryKindState(effectiveEntryType);

  const [title, setTitle] = useState(editData?.title ?? "");
  const [username, setUsername] = useState(editData?.username ?? "");
  const [password, setPassword] = useState(editData?.password ?? "");
  const [content, setContent] = useState(editData?.content ?? "");
  const [url, setUrl] = useState(editData?.url ?? "");
  const [notes, setNotes] = useState(editData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<OrgTagData[]>(
    editData?.tags ?? []
  );
  const [generatorSettings, setGeneratorSettings] = useState<GeneratorSettings>(
    { ...DEFAULT_GENERATOR_SETTINGS }
  );
  const [customFields, setCustomFields] = useState<EntryCustomField[]>(
    editData?.customFields ?? []
  );
  const [totp, setTotp] = useState<EntryTotp | null>(
    editData?.totp ?? null
  );
  const [showTotpInput, setShowTotpInput] = useState(!!editData?.totp);
  const [cardholderName, setCardholderName] = useState(editData?.cardholderName ?? "");
  const [cardNumber, setCardNumber] = useState(
    formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? "")
  );
  const [brand, setBrand] = useState(editData?.brand ?? "");
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(
    editData?.brand ? "manual" : "auto"
  );
  const [expiryMonth, setExpiryMonth] = useState(editData?.expiryMonth ?? "");
  const [expiryYear, setExpiryYear] = useState(editData?.expiryYear ?? "");
  const [cvv, setCvv] = useState(editData?.cvv ?? "");
  const [fullName, setFullName] = useState(editData?.fullName ?? "");
  const [address, setAddress] = useState(editData?.address ?? "");
  const [phone, setPhone] = useState(editData?.phone ?? "");
  const [email, setEmail] = useState(editData?.email ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(editData?.dateOfBirth ?? "");
  const [nationality, setNationality] = useState(editData?.nationality ?? "");
  const [idNumber, setIdNumber] = useState(editData?.idNumber ?? "");
  const [issueDate, setIssueDate] = useState(editData?.issueDate ?? "");
  const [expiryDate, setExpiryDate] = useState(editData?.expiryDate ?? "");
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [dobError, setDobError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [relyingPartyId, setRelyingPartyId] = useState(editData?.relyingPartyId ?? "");
  const [relyingPartyName, setRelyingPartyName] = useState(editData?.relyingPartyName ?? "");
  const [credentialId, setCredentialId] = useState(editData?.credentialId ?? "");
  const [creationDate, setCreationDate] = useState(editData?.creationDate ?? "");
  const [deviceInfo, setDeviceInfo] = useState(editData?.deviceInfo ?? "");
  const [showCredentialId, setShowCredentialId] = useState(false);
  const { attachments, setAttachments } = useOrgAttachments(open, orgId, editData?.id);
  const [orgFolderId, setOrgFolderId] = useState<string | null>(editData?.orgFolderId ?? null);
  const orgFolders = useOrgFolders(open, orgId);

  const isEdit = !!editData;

  const formSetters: OrgPasswordFormSetters = {
    setTitle,
    setUsername,
    setPassword,
    setContent,
    setUrl,
    setNotes,
    setSelectedTags,
    setCustomFields,
    setTotp,
    setShowTotpInput,
    setCardholderName,
    setCardNumber,
    setBrand,
    setBrandSource,
    setExpiryMonth,
    setExpiryYear,
    setCvv,
    setFullName,
    setAddress,
    setPhone,
    setEmail,
    setDateOfBirth,
    setNationality,
    setIdNumber,
    setIssueDate,
    setExpiryDate,
    setRelyingPartyId,
    setRelyingPartyName,
    setCredentialId,
    setCreationDate,
    setDeviceInfo,
    setOrgFolderId,
    setShowPassword,
    setShowGenerator,
    setShowCardNumber,
    setShowCvv,
    setShowIdNumber,
    setShowCredentialId,
    setAttachments,
    setSaving,
  };
  const { handleOpenChange } = useOrgPasswordFormLifecycle({
    open,
    editData,
    onOpenChange,
    setters: formSetters,
  });

  const {
    cardValidation,
    lengthHint,
    maxInputLength,
    showLengthError,
    showLuhnError,
    cardNumberValid,
    hasBrandHint,
  } = getOrgCardValidationState(cardNumber, brand);

  const handleCardNumberChange = (value: string) => {
    const digits = normalizeCardNumber(value);
    const detected = detectCardBrand(digits);
    const nextBrand =
      brandSource === "manual" ? brand : (detected || "");
    const formatted = formatCardNumber(digits, nextBrand || detected);

    setCardNumber(formatted);

    if (brandSource === "auto") {
      setBrand(detected);
    }
  };

  const handleSubmit = async () => {
    const validation = validateOrgEntryBeforeSubmit({
      entryType: effectiveEntryType,
      title,
      password,
      relyingPartyId,
      cardNumberValid,
      dateOfBirth,
      issueDate,
      expiryDate,
    });
    if (isIdentity) {
      setDobError(validation.dobFuture ? ti("dobFuture") : null);
      setExpiryError(validation.expiryBeforeIssue ? ti("expiryBeforeIssue") : null);
    }
    if (!validation.ok) return;
    const tagIds = extractTagIds(selectedTags);
    const body = buildOrgEntryPayload({
      entryType: effectiveEntryType,
      title,
      notes,
      tagIds,
      orgFolderId,
      username,
      password,
      url,
      customFields,
      totp,
      content,
      cardholderName,
      cardNumber: normalizeCardNumber(cardNumber),
      brand: normalizeCardBrand(brand),
      expiryMonth,
      expiryYear,
      cvv,
      fullName,
      address,
      phone,
      email,
      dateOfBirth,
      nationality,
      idNumber,
      issueDate,
      expiryDate,
      relyingPartyId,
      relyingPartyName,
      credentialId,
      creationDate,
      deviceInfo,
    });
    await executeOrgEntrySubmit({
      orgId,
      isEdit,
      editData,
      body,
      t,
      setSaving,
      handleOpenChange,
      onSaved,
    });
  };

  const generatorSummary = buildGeneratorSummary(generatorSettings, {
    modePassphrase: tGen("modePassphrase"),
    modePassword: tGen("modePassword"),
  });

  const entryCopy = buildOrgEntryCopy({
    isEdit,
    entryKind,
    copyByKind: buildOrgEntryCopyData({ t, tn, tcc, ti, tpk }),
  });

  const { hasChanges, submitDisabled } = useOrgPasswordFormDerived({
    effectiveEntryType,
    editData,
    isLoginEntry,
    isNote,
    isCreditCard,
    isIdentity,
    isPasskey,
    title,
    notes,
    selectedTags,
    orgFolderId,
    username,
    password,
    url,
    customFields,
    totp,
    content,
    cardholderName,
    cardNumber,
    brand,
    expiryMonth,
    expiryYear,
    cvv,
    fullName,
    address,
    phone,
    email,
    dateOfBirth,
    nationality,
    idNumber,
    issueDate,
    expiryDate,
    relyingPartyId,
    relyingPartyName,
    credentialId,
    creationDate,
    deviceInfo,
    cardNumberValid,
  });
  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;

  const entrySpecificFieldsProps = useOrgEntrySpecificFieldsProps({
    entryKind,
    entryCopy,
    t,
    tn,
    tcc,
    ti,
    tpk,
    notes,
    onNotesChange: setNotes,
    title,
    onTitleChange: setTitle,
    username,
    onUsernameChange: setUsername,
    password,
    onPasswordChange: setPassword,
    showPassword,
    onToggleShowPassword: () => setShowPassword((v) => !v),
    generatorSummary,
    showGenerator,
    onToggleGenerator: () => setShowGenerator((v) => !v),
    generatorSettings,
    onGeneratorUse: (pw, settings) => {
      setPassword(pw);
      setShowPassword(true);
      setGeneratorSettings(settings);
    },
    url,
    onUrlChange: setUrl,
    content,
    onContentChange: setContent,
    cardholderName,
    onCardholderNameChange: setCardholderName,
    brand,
    onBrandChange: (value) => {
      setBrand(value);
      setBrandSource("manual");
    },
    cardNumber,
    onCardNumberChange: handleCardNumberChange,
    showCardNumber,
    onToggleCardNumber: () => setShowCardNumber(!showCardNumber),
    maxInputLength,
    showLengthError,
    showLuhnError,
    detectedBrand: cardValidation.detectedBrand
      ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
      : undefined,
    hasBrandHint: hasBrandHint && cardValidation.digits.length > 0,
    lengthHint,
    expiryMonth,
    onExpiryMonthChange: setExpiryMonth,
    expiryYear,
    onExpiryYearChange: setExpiryYear,
    cvv,
    onCvvChange: setCvv,
    showCvv,
    onToggleCvv: () => setShowCvv(!showCvv),
    fullName,
    onFullNameChange: setFullName,
    address,
    onAddressChange: setAddress,
    phone,
    onPhoneChange: setPhone,
    email,
    onEmailChange: setEmail,
    dateOfBirth,
    onDateOfBirthChange: (value) => {
      setDateOfBirth(value);
      setDobError(null);
    },
    nationality,
    onNationalityChange: setNationality,
    idNumber,
    onIdNumberChange: setIdNumber,
    showIdNumber,
    onToggleIdNumber: () => setShowIdNumber(!showIdNumber),
    issueDate,
    onIssueDateChange: (value) => {
      setIssueDate(value);
      setExpiryError(null);
    },
    expiryDate,
    onExpiryDateChange: (value) => {
      setExpiryDate(value);
      setExpiryError(null);
    },
    dobError,
    expiryError,
    relyingPartyId,
    onRelyingPartyIdChange: setRelyingPartyId,
    relyingPartyName,
    onRelyingPartyNameChange: setRelyingPartyName,
    credentialId,
    onCredentialIdChange: setCredentialId,
    showCredentialId,
    onToggleCredentialId: () => setShowCredentialId(!showCredentialId),
    creationDate,
    onCreationDateChange: setCreationDate,
    deviceInfo,
    onDeviceInfoChange: setDeviceInfo,
  });

  const entrySpecificFields = <OrgEntrySpecificFields {...entrySpecificFieldsProps} />;

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entryCopy.dialogLabel}</DialogTitle>
          <DialogDescription className="sr-only">{entryCopy.dialogLabel}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleFormSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
          <div className="space-y-5">
          {/* Title */}
          <div className="space-y-2">
            <Label>{entryCopy.titleLabel}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={entryCopy.titlePlaceholder}
            />
          </div>

          {entrySpecificFields}

          <OrgTagsAndFolderSection
            tagsTitle={entryCopy.tagsTitle}
            tagsHint={t("tagsHint")}
            orgId={orgId}
            selectedTags={selectedTags}
            onTagsChange={setSelectedTags}
            folders={orgFolders}
            folderId={orgFolderId}
            onFolderChange={setOrgFolderId}
            sectionCardClass={dialogSectionClass}
          />

          {isLoginEntry && (
            <EntryCustomFieldsTotpSection
              customFields={customFields}
              setCustomFields={setCustomFields}
              totp={totp}
              onTotpChange={setTotp}
              showTotpInput={showTotpInput}
              setShowTotpInput={setShowTotpInput}
              sectionCardClass={dialogSectionClass}
            />
          )}
          </div>

        {/* Actions */}
        <EntryActionBar
          hasChanges={hasChanges}
          submitting={saving}
          submitDisabled={submitDisabled}
          saveLabel={isEdit ? tc("update") : tc("save")}
          cancelLabel={tc("cancel")}
          statusUnsavedLabel={t("statusUnsaved")}
          statusSavedLabel={t("statusSaved")}
          onCancel={() => handleOpenChange(false)}
        />
        </form>

        {/* Attachments (edit mode only) */}
        {isEdit && editData && (
          <div className="border-t pt-4">
            <OrgAttachmentSection
              orgId={orgId}
              entryId={editData.id}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
