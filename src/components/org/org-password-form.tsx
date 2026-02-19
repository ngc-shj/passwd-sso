"use client";

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
import { buildGeneratorSummary } from "@/lib/generator-summary";
import { executeOrgEntrySubmit } from "@/components/org/org-entry-submit";
import { useOrgFolders } from "@/hooks/use-org-folders";
import { useOrgAttachments } from "@/hooks/use-org-attachments";
import { useOrgEntrySpecificFieldsProps } from "@/hooks/use-org-entry-specific-fields-props";
import { useOrgPasswordFormDerived } from "@/hooks/use-org-password-form-derived";
import { useOrgPasswordFormLifecycle } from "@/hooks/use-org-password-form-lifecycle";
import { useOrgPasswordFormState } from "@/hooks/use-org-password-form-state";

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

  const effectiveEntryType = editData?.entryType ?? entryTypeProp;
  const { entryKind, isNote, isCreditCard, isIdentity, isPasskey, isLoginEntry } =
    getOrgEntryKindState(effectiveEntryType);
  const {
    values: {
      saving,
      showPassword,
      showGenerator,
      showCardNumber,
      showCvv,
      showIdNumber,
      showCredentialId,
      title,
      username,
      password,
      content,
      url,
      notes,
      selectedTags,
      generatorSettings,
      customFields,
      totp,
      showTotpInput,
      cardholderName,
      cardNumber,
      brand,
      brandSource,
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
      dobError,
      expiryError,
      relyingPartyId,
      relyingPartyName,
      credentialId,
      creationDate,
      deviceInfo,
      orgFolderId,
    },
    setters: {
      setSaving,
      setShowPassword,
      setShowGenerator,
      setShowCardNumber,
      setShowCvv,
      setShowIdNumber,
      setShowCredentialId,
      setTitle,
      setUsername,
      setPassword,
      setContent,
      setUrl,
      setNotes,
      setSelectedTags,
      setGeneratorSettings,
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
      setDobError,
      setExpiryError,
      setRelyingPartyId,
      setRelyingPartyName,
      setCredentialId,
      setCreationDate,
      setDeviceInfo,
      setOrgFolderId,
    },
  } = useOrgPasswordFormState(editData);
  const { attachments, setAttachments } = useOrgAttachments(open, orgId, editData?.id);
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
