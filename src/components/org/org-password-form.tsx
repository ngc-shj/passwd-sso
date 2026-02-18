"use client";

import { useState, useEffect, useMemo } from "react";
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
import { OrgAttachmentSection, type OrgAttachmentMeta } from "./org-attachment-section";
import { OrgCreditCardFields } from "@/components/org/org-credit-card-fields";
import { OrgIdentityFields } from "@/components/org/org-identity-fields";
import { OrgLoginFields } from "@/components/org/org-login-fields";
import { OrgPasskeyFields } from "@/components/org/org-passkey-fields";
import { OrgSecureNoteFields } from "@/components/org/org-secure-note-fields";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
} from "@/components/org/org-password-form-snapshot";
import { OrgTagsAndFolderSection } from "@/components/org/org-tags-and-folder-section";
import type {
  OrgFolderItem,
  OrgPasswordFormEditData,
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
import { toast } from "sonner";
import {
  CARD_BRANDS,
  detectCardBrand,
  formatCardNumber,
  getAllowedLengths,
  getCardNumberValidation,
  getMaxLength,
  normalizeCardBrand,
  normalizeCardNumber,
} from "@/lib/credit-card";
import {
  extractTagIds,
} from "@/lib/entry-form-helpers";
import { buildOrgEntryPayload } from "@/lib/org-entry-payload";
import { validateOrgEntryBeforeSubmit } from "@/lib/org-entry-validation";
import { ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

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
  const isNote = effectiveEntryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = effectiveEntryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = effectiveEntryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = effectiveEntryType === ENTRY_TYPE.PASSKEY;
  const isLoginEntry = !isNote && !isCreditCard && !isIdentity && !isPasskey;

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
  const [attachments, setAttachments] = useState<OrgAttachmentMeta[]>([]);
  const [orgFolderId, setOrgFolderId] = useState<string | null>(editData?.orgFolderId ?? null);
  const [orgFolders, setOrgFolders] = useState<OrgFolderItem[]>([]);

  const isEdit = !!editData;

  const applyEditDataToForm = (data: OrgPasswordFormEditData) => {
    setTitle(data.title);
    setUsername(data.username ?? "");
    setPassword(data.password ?? "");
    setContent(data.content ?? "");
    setUrl(data.url ?? "");
    setNotes(data.notes ?? "");
    setSelectedTags(data.tags ?? []);
    setCustomFields(data.customFields ?? []);
    setTotp(data.totp ?? null);
    setShowTotpInput(!!data.totp);
    setCardholderName(data.cardholderName ?? "");
    setCardNumber(formatCardNumber(data.cardNumber ?? "", data.brand ?? ""));
    setBrand(data.brand ?? "");
    setBrandSource(data.brand ? "manual" : "auto");
    setExpiryMonth(data.expiryMonth ?? "");
    setExpiryYear(data.expiryYear ?? "");
    setCvv(data.cvv ?? "");
    setFullName(data.fullName ?? "");
    setAddress(data.address ?? "");
    setPhone(data.phone ?? "");
    setEmail(data.email ?? "");
    setDateOfBirth(data.dateOfBirth ?? "");
    setNationality(data.nationality ?? "");
    setIdNumber(data.idNumber ?? "");
    setIssueDate(data.issueDate ?? "");
    setExpiryDate(data.expiryDate ?? "");
    setRelyingPartyId(data.relyingPartyId ?? "");
    setRelyingPartyName(data.relyingPartyName ?? "");
    setCredentialId(data.credentialId ?? "");
    setCreationDate(data.creationDate ?? "");
    setDeviceInfo(data.deviceInfo ?? "");
    setOrgFolderId(data.orgFolderId ?? null);
  };

  const resetFormForClose = () => {
    setTitle("");
    setUsername("");
    setPassword("");
    setContent("");
    setUrl("");
    setNotes("");
    setSelectedTags([]);
    setCustomFields([]);
    setTotp(null);
    setShowTotpInput(false);
    setShowPassword(false);
    setShowGenerator(false);
    setCardholderName("");
    setCardNumber("");
    setBrand("");
    setBrandSource("auto");
    setExpiryMonth("");
    setExpiryYear("");
    setCvv("");
    setShowCardNumber(false);
    setShowCvv(false);
    setFullName("");
    setAddress("");
    setPhone("");
    setEmail("");
    setDateOfBirth("");
    setNationality("");
    setIdNumber("");
    setIssueDate("");
    setExpiryDate("");
    setShowIdNumber(false);
    setRelyingPartyId("");
    setRelyingPartyName("");
    setCredentialId("");
    setCreationDate("");
    setDeviceInfo("");
    setShowCredentialId(false);
    setAttachments([]);
    setOrgFolderId(null);
    setSaving(false);
  };

  // Fetch org folders for the folder selector
  useEffect(() => {
    if (open) {
      fetch(apiPath.orgFolders(orgId))
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => { if (Array.isArray(data)) setOrgFolders(data); })
        .catch(() => {});
    }
  }, [open, orgId]);

  // Sync form fields when editData changes (programmatic open)
  useEffect(() => {
    if (open && editData) {
      applyEditDataToForm(editData);

      // Load attachments for edit mode
      fetch(apiPath.orgPasswordAttachments(orgId, editData.id))
        .then((res) => (res.ok ? res.json() : []))
        .then((loaded: OrgAttachmentMeta[]) => setAttachments(loaded))
        .catch(() => setAttachments([]));
    }
  }, [open, editData, orgId]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      resetFormForClose();
    } else if (editData) {
      applyEditDataToForm(editData);
    }
    onOpenChange(v);
  };

  const cardValidation = getCardNumberValidation(cardNumber, brand);
  const allowedLengths = getAllowedLengths(cardValidation.effectiveBrand);
  const lengthHint = allowedLengths
    ? allowedLengths.join("/")
    : "12-19";
  const maxDigits = getMaxLength(cardValidation.effectiveBrand || cardValidation.detectedBrand);
  const maxInputLength =
    cardValidation.effectiveBrand === "American Express"
      ? maxDigits + 2
      : maxDigits + Math.floor((maxDigits - 1) / 4);
  const showLengthError = cardValidation.digits.length > 0 && !cardValidation.lengthValid;
  const showLuhnError =
    cardValidation.digits.length > 0 &&
    cardValidation.lengthValid &&
    !cardValidation.luhnValid;
  const cardNumberValid =
    cardValidation.digits.length === 0 ||
    (cardValidation.lengthValid && cardValidation.luhnValid);
  const hasBrandHint = Boolean(cardValidation.effectiveBrand && cardValidation.effectiveBrand !== "Other");

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
    setSaving(true);

    try {
      const endpoint = isEdit
        ? apiPath.orgPasswordById(orgId, editData.id)
        : apiPath.orgPasswords(orgId);
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

      const res = await fetch(endpoint, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed");

      toast.success(isEdit ? t("updated") : t("saved"));
      handleOpenChange(false);
      onSaved();
    } catch {
      toast.error(t("failedToSave"));
      setSaving(false);
    }
  };

  const generatorSummary =
    generatorSettings.mode === "passphrase"
      ? `${tGen("modePassphrase")} · ${generatorSettings.passphrase.wordCount}`
      : `${tGen("modePassword")} · ${generatorSettings.length}`;

  const entryKind = isPasskey
    ? "passkey"
    : isIdentity
      ? "identity"
      : isCreditCard
        ? "creditCard"
        : isNote
          ? "secureNote"
          : "password";

  const entryCopies = {
    passkey: {
      dialogLabel: isEdit ? tpk("editPasskey") : tpk("newPasskey"),
      titleLabel: tpk("title"),
      titlePlaceholder: tpk("titlePlaceholder"),
      notesLabel: tpk("notes"),
      notesPlaceholder: tpk("notesPlaceholder"),
      tagsTitle: tpk("tags"),
    },
    identity: {
      dialogLabel: isEdit ? ti("editIdentity") : ti("newIdentity"),
      titleLabel: ti("title"),
      titlePlaceholder: ti("titlePlaceholder"),
      notesLabel: ti("notes"),
      notesPlaceholder: ti("notesPlaceholder"),
      tagsTitle: ti("tags"),
    },
    creditCard: {
      dialogLabel: isEdit ? tcc("editCard") : tcc("newCard"),
      titleLabel: tcc("title"),
      titlePlaceholder: tcc("titlePlaceholder"),
      notesLabel: tcc("notes"),
      notesPlaceholder: tcc("notesPlaceholder"),
      tagsTitle: tcc("tags"),
    },
    secureNote: {
      dialogLabel: isEdit ? tn("editNote") : tn("newNote"),
      titleLabel: tn("title"),
      titlePlaceholder: tn("titlePlaceholder"),
      notesLabel: tn("notes"),
      notesPlaceholder: tn("notesPlaceholder"),
      tagsTitle: tn("tags"),
    },
    password: {
      dialogLabel: isEdit ? t("editPassword") : t("newPassword"),
      titleLabel: t("title"),
      titlePlaceholder: t("titlePlaceholder"),
      notesLabel: t("notes"),
      notesPlaceholder: t("notesPlaceholder"),
      tagsTitle: t("tags"),
    },
  } as const;

  const entryCopy = entryCopies[entryKind];

  const baselineSnapshot = useMemo(
    () =>
      buildBaselineSnapshot({
        effectiveEntryType,
        editData,
        isLoginEntry,
        isNote,
        isCreditCard,
        isIdentity,
        isPasskey,
      }),
    [editData, effectiveEntryType, isNote, isCreditCard, isIdentity, isPasskey, isLoginEntry]
  );

  const currentSnapshot = useMemo(
    () =>
      buildCurrentSnapshot({
        effectiveEntryType,
        title,
        notes,
        selectedTags,
        orgFolderId,
        isLoginEntry,
        isNote,
        isCreditCard,
        isIdentity,
        isPasskey,
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
      }),
    [
      effectiveEntryType,
      title,
      notes,
      selectedTags,
      isNote,
      isCreditCard,
      isIdentity,
      isPasskey,
      isLoginEntry,
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
      orgFolderId,
    ]
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const dialogSectionClass = ENTRY_DIALOG_FLAT_SECTION_CLASS;
  const submitDisabled =
    !title.trim() ||
    (isPasskey && !relyingPartyId.trim()) ||
    (isLoginEntry && !password) ||
    (isCreditCard && !cardNumberValid);

  const entrySpecificFields = (() => {
    switch (entryKind) {
      case "passkey":
        return (
          <OrgPasskeyFields
            relyingPartyId={relyingPartyId}
            onRelyingPartyIdChange={setRelyingPartyId}
            relyingPartyIdPlaceholder={tpk("relyingPartyIdPlaceholder")}
            relyingPartyName={relyingPartyName}
            onRelyingPartyNameChange={setRelyingPartyName}
            relyingPartyNamePlaceholder={tpk("relyingPartyNamePlaceholder")}
            username={username}
            onUsernameChange={setUsername}
            usernamePlaceholder={tpk("usernamePlaceholder")}
            credentialId={credentialId}
            onCredentialIdChange={setCredentialId}
            credentialIdPlaceholder={tpk("credentialIdPlaceholder")}
            showCredentialId={showCredentialId}
            onToggleCredentialId={() => setShowCredentialId(!showCredentialId)}
            creationDate={creationDate}
            onCreationDateChange={setCreationDate}
            deviceInfo={deviceInfo}
            onDeviceInfoChange={setDeviceInfo}
            deviceInfoPlaceholder={tpk("deviceInfoPlaceholder")}
            notesLabel={entryCopy.notesLabel}
            notes={notes}
            onNotesChange={setNotes}
            notesPlaceholder={entryCopy.notesPlaceholder}
            labels={{
              relyingPartyId: tpk("relyingPartyId"),
              relyingPartyName: tpk("relyingPartyName"),
              username: tpk("username"),
              credentialId: tpk("credentialId"),
              creationDate: tpk("creationDate"),
              deviceInfo: tpk("deviceInfo"),
            }}
          />
        );
      case "identity":
        return (
          <OrgIdentityFields
            fullName={fullName}
            onFullNameChange={setFullName}
            fullNamePlaceholder={ti("fullNamePlaceholder")}
            address={address}
            onAddressChange={setAddress}
            addressPlaceholder={ti("addressPlaceholder")}
            phone={phone}
            onPhoneChange={setPhone}
            phonePlaceholder={ti("phonePlaceholder")}
            email={email}
            onEmailChange={setEmail}
            emailPlaceholder={ti("emailPlaceholder")}
            dateOfBirth={dateOfBirth}
            onDateOfBirthChange={(value) => {
              setDateOfBirth(value);
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
            onIssueDateChange={(value) => {
              setIssueDate(value);
              setExpiryError(null);
            }}
            expiryDate={expiryDate}
            onExpiryDateChange={(value) => {
              setExpiryDate(value);
              setExpiryError(null);
            }}
            dobError={dobError}
            expiryError={expiryError}
            notesLabel={entryCopy.notesLabel}
            notes={notes}
            onNotesChange={setNotes}
            notesPlaceholder={entryCopy.notesPlaceholder}
            labels={{
              fullName: ti("fullName"),
              address: ti("address"),
              phone: ti("phone"),
              email: ti("email"),
              dateOfBirth: ti("dateOfBirth"),
              nationality: ti("nationality"),
              idNumber: ti("idNumber"),
              issueDate: ti("issueDate"),
              expiryDate: ti("expiryDate"),
            }}
          />
        );
      case "creditCard":
        return (
          <OrgCreditCardFields
            cardholderName={cardholderName}
            onCardholderNameChange={setCardholderName}
            cardholderNamePlaceholder={tcc("cardholderNamePlaceholder")}
            brand={brand}
            onBrandChange={(value) => {
              setBrand(value);
              setBrandSource("manual");
            }}
            brandPlaceholder={tcc("brandPlaceholder")}
            brands={CARD_BRANDS}
            cardNumber={cardNumber}
            onCardNumberChange={handleCardNumberChange}
            cardNumberPlaceholder={tcc("cardNumberPlaceholder")}
            showCardNumber={showCardNumber}
            onToggleCardNumber={() => setShowCardNumber(!showCardNumber)}
            maxInputLength={maxInputLength}
            showLengthError={showLengthError}
            showLuhnError={showLuhnError}
            detectedBrand={
              cardValidation.detectedBrand
                ? tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })
                : undefined
            }
            hasBrandHint={hasBrandHint && cardValidation.digits.length > 0}
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
            notesLabel={entryCopy.notesLabel}
            notes={notes}
            onNotesChange={setNotes}
            notesPlaceholder={entryCopy.notesPlaceholder}
            labels={{
              cardholderName: tcc("cardholderName"),
              brand: tcc("brand"),
              cardNumber: tcc("cardNumber"),
              expiry: tcc("expiry"),
              cvv: tcc("cvv"),
            }}
          />
        );
      case "secureNote":
        return (
          <OrgSecureNoteFields
            content={content}
            onContentChange={setContent}
            contentLabel={tn("content")}
            contentPlaceholder={tn("contentPlaceholder")}
          />
        );
      case "password":
      default:
        return (
          <OrgLoginFields
            title={title}
            onTitleChange={setTitle}
            titleLabel={t("title")}
            titlePlaceholder={t("titlePlaceholder")}
            username={username}
            onUsernameChange={setUsername}
            usernameLabel={t("usernameEmail")}
            usernamePlaceholder={t("usernamePlaceholder")}
            password={password}
            onPasswordChange={setPassword}
            passwordLabel={t("password")}
            passwordPlaceholder={t("passwordPlaceholder")}
            showPassword={showPassword}
            onToggleShowPassword={() => setShowPassword((v) => !v)}
            generatorSummary={generatorSummary}
            showGenerator={showGenerator}
            onToggleGenerator={() => setShowGenerator((v) => !v)}
            closeGeneratorLabel={t("closeGenerator")}
            openGeneratorLabel={t("openGenerator")}
            generatorSettings={generatorSettings}
            onGeneratorUse={(pw, settings) => {
              setPassword(pw);
              setShowPassword(true);
              setGeneratorSettings(settings);
            }}
            url={url}
            onUrlChange={setUrl}
            urlLabel={t("url")}
            notes={notes}
            onNotesChange={setNotes}
            notesLabel={entryCopy.notesLabel}
            notesPlaceholder={entryCopy.notesPlaceholder}
          />
        );
    }
  })();

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
