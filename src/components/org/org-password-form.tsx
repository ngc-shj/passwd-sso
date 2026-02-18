"use client";

import { useState, useEffect, useMemo, type ComponentProps, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry-custom-fields-totp-section";
import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import { EntryTagsSection } from "@/components/passwords/entry-tags-section";
import { OrgTagInput, type OrgTagData } from "./org-tag-input";
import { OrgAttachmentSection, type OrgAttachmentMeta } from "./org-attachment-section";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import { preventIMESubmit } from "@/lib/ime-guard";
import { Eye, EyeOff } from "lucide-react";
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
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";

interface OrgFolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

interface OrgPasswordFormProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  entryType?: EntryTypeValue;
  editData?: {
    id: string;
    entryType?: EntryTypeValue;
    title: string;
    username: string | null;
    password: string;
    content?: string;
    url: string | null;
    notes: string | null;
    tags?: OrgTagData[];
    customFields?: EntryCustomField[];
    totp?: EntryTotp | null;
    cardholderName?: string | null;
    cardNumber?: string | null;
    brand?: string | null;
    expiryMonth?: string | null;
    expiryYear?: string | null;
    cvv?: string | null;
    fullName?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    dateOfBirth?: string | null;
    nationality?: string | null;
    idNumber?: string | null;
    issueDate?: string | null;
    expiryDate?: string | null;
    relyingPartyId?: string | null;
    relyingPartyName?: string | null;
    credentialId?: string | null;
    creationDate?: string | null;
    deviceInfo?: string | null;
    orgFolderId?: string | null;
  } | null;
}

interface OrgTagSectionProps {
  title: string;
  hint: string;
  orgId: string;
  selectedTags: OrgTagData[];
  onChange: (tags: OrgTagData[]) => void;
  sectionCardClass?: string;
}

interface VisibilityToggleInputProps {
  show: boolean;
  onToggle: () => void;
  inputProps: ComponentProps<typeof Input>;
}

interface TwoColumnFieldsProps {
  left: ReactNode;
  right: ReactNode;
}

function OrgTagSection({
  title,
  hint,
  orgId,
  selectedTags,
  onChange,
  sectionCardClass = "",
}: OrgTagSectionProps) {
  return (
    <EntryTagsSection title={title} hint={hint} sectionCardClass={sectionCardClass}>
      <OrgTagInput orgId={orgId} selectedTags={selectedTags} onChange={onChange} />
    </EntryTagsSection>
  );
}

function VisibilityToggleInput({
  show,
  onToggle,
  inputProps,
}: VisibilityToggleInputProps) {
  return (
    <div className="relative">
      <Input
        {...inputProps}
        type={show ? "text" : "password"}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
        onClick={onToggle}
      >
        {show ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function TwoColumnFields({ left, right }: TwoColumnFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">{left}</div>
      <div className="space-y-2">{right}</div>
    </div>
  );
}

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

  const applyEditDataToForm = (data: NonNullable<OrgPasswordFormProps["editData"]>) => {
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

  const entryCopy = isPasskey
    ? {
        dialogLabel: isEdit ? tpk("editPasskey") : tpk("newPasskey"),
        titleLabel: tpk("title"),
        titlePlaceholder: tpk("titlePlaceholder"),
        notesLabel: tpk("notes"),
        notesPlaceholder: tpk("notesPlaceholder"),
        tagsTitle: tpk("tags"),
      }
    : isIdentity
      ? {
          dialogLabel: isEdit ? ti("editIdentity") : ti("newIdentity"),
          titleLabel: ti("title"),
          titlePlaceholder: ti("titlePlaceholder"),
          notesLabel: ti("notes"),
          notesPlaceholder: ti("notesPlaceholder"),
          tagsTitle: ti("tags"),
        }
      : isCreditCard
        ? {
            dialogLabel: isEdit ? tcc("editCard") : tcc("newCard"),
            titleLabel: tcc("title"),
            titlePlaceholder: tcc("titlePlaceholder"),
            notesLabel: tcc("notes"),
            notesPlaceholder: tcc("notesPlaceholder"),
            tagsTitle: tcc("tags"),
          }
        : isNote
          ? {
              dialogLabel: isEdit ? tn("editNote") : tn("newNote"),
              titleLabel: tn("title"),
              titlePlaceholder: tn("titlePlaceholder"),
              notesLabel: tn("notes"),
              notesPlaceholder: tn("notesPlaceholder"),
              tagsTitle: tn("tags"),
            }
          : {
              dialogLabel: isEdit ? t("editPassword") : t("newPassword"),
              titleLabel: t("title"),
              titlePlaceholder: t("titlePlaceholder"),
              notesLabel: t("notes"),
              notesPlaceholder: t("notesPlaceholder"),
              tagsTitle: t("tags"),
            };

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        entryType: effectiveEntryType,
        title: editData?.title ?? "",
        notes: editData?.notes ?? "",
        selectedTagIds: (editData?.tags ?? []).map((tag) => tag.id).sort(),
        orgFolderId: editData?.orgFolderId ?? null,
        login: isNote || isCreditCard || isIdentity || isPasskey
          ? null
          : {
              username: editData?.username ?? "",
              password: editData?.password ?? "",
              url: editData?.url ?? "",
              customFields: editData?.customFields ?? [],
              totp: editData?.totp ?? null,
            },
        secureNote: isNote
          ? {
              content: editData?.content ?? "",
            }
          : null,
        creditCard: isCreditCard
          ? {
              cardholderName: editData?.cardholderName ?? "",
              cardNumber: formatCardNumber(editData?.cardNumber ?? "", editData?.brand ?? ""),
              brand: editData?.brand ?? "",
              expiryMonth: editData?.expiryMonth ?? "",
              expiryYear: editData?.expiryYear ?? "",
              cvv: editData?.cvv ?? "",
            }
          : null,
        identity: isIdentity
          ? {
              fullName: editData?.fullName ?? "",
              address: editData?.address ?? "",
              phone: editData?.phone ?? "",
              email: editData?.email ?? "",
              dateOfBirth: editData?.dateOfBirth ?? "",
              nationality: editData?.nationality ?? "",
              idNumber: editData?.idNumber ?? "",
              issueDate: editData?.issueDate ?? "",
              expiryDate: editData?.expiryDate ?? "",
            }
          : null,
        passkey: isPasskey
          ? {
              relyingPartyId: editData?.relyingPartyId ?? "",
              relyingPartyName: editData?.relyingPartyName ?? "",
              username: editData?.username ?? "",
              credentialId: editData?.credentialId ?? "",
              creationDate: editData?.creationDate ?? "",
              deviceInfo: editData?.deviceInfo ?? "",
            }
          : null,
      }),
    [editData, effectiveEntryType, isNote, isCreditCard, isIdentity, isPasskey]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        entryType: effectiveEntryType,
        title,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
        orgFolderId,
        login: isNote || isCreditCard || isIdentity || isPasskey
          ? null
          : { username, password, url, customFields, totp },
        secureNote: isNote ? { content } : null,
        creditCard: isCreditCard
          ? { cardholderName, cardNumber, brand, expiryMonth, expiryYear, cvv }
          : null,
        identity: isIdentity
          ? {
              fullName,
              address,
              phone,
              email,
              dateOfBirth,
              nationality,
              idNumber,
              issueDate,
              expiryDate,
            }
          : null,
        passkey: isPasskey
          ? {
              relyingPartyId,
              relyingPartyName,
              username,
              credentialId,
              creationDate,
              deviceInfo,
            }
          : null,
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

          {isPasskey ? (
            <>
              {/* Relying Party ID */}
              <div className="space-y-2">
                <Label>{tpk("relyingPartyId")}</Label>
                <Input
                  value={relyingPartyId}
                  onChange={(e) => setRelyingPartyId(e.target.value)}
                  placeholder={tpk("relyingPartyIdPlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Relying Party Name */}
              <div className="space-y-2">
                <Label>{tpk("relyingPartyName")}</Label>
                <Input
                  value={relyingPartyName}
                  onChange={(e) => setRelyingPartyName(e.target.value)}
                  placeholder={tpk("relyingPartyNamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Username */}
              <div className="space-y-2">
                <Label>{tpk("username")}</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={tpk("usernamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Credential ID */}
              <div className="space-y-2">
                <Label>{tpk("credentialId")}</Label>
                <VisibilityToggleInput
                  show={showCredentialId}
                  onToggle={() => setShowCredentialId(!showCredentialId)}
                  inputProps={{
                    value: credentialId,
                    onChange: (e) => setCredentialId(e.target.value),
                    placeholder: tpk("credentialIdPlaceholder"),
                    autoComplete: "off",
                  }}
                />
              </div>

              {/* Creation Date & Device Info */}
              <TwoColumnFields
                left={(
                  <>
                    <Label>{tpk("creationDate")}</Label>
                    <Input
                      type="date"
                      value={creationDate}
                      onChange={(e) => setCreationDate(e.target.value)}
                    />
                  </>
                )}
                right={(
                  <>
                    <Label>{tpk("deviceInfo")}</Label>
                    <Input
                      value={deviceInfo}
                      onChange={(e) => setDeviceInfo(e.target.value)}
                      placeholder={tpk("deviceInfoPlaceholder")}
                      autoComplete="off"
                    />
                  </>
                )}
              />

              {/* Notes */}
              <div className="space-y-2">
                <Label>{entryCopy.notesLabel}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={entryCopy.notesPlaceholder}
                  rows={3}
                />
              </div>
            </>
          ) : isIdentity ? (
            <>
              {/* Full Name */}
              <div className="space-y-2">
                <Label>{ti("fullName")}</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={ti("fullNamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Address */}
              <div className="space-y-2">
                <Label>{ti("address")}</Label>
                <Textarea
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={ti("addressPlaceholder")}
                  rows={2}
                  autoComplete="off"
                />
              </div>

              {/* Phone & Email */}
              <TwoColumnFields
                left={(
                  <>
                    <Label>{ti("phone")}</Label>
                    <Input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder={ti("phonePlaceholder")}
                      autoComplete="off"
                    />
                  </>
                )}
                right={(
                  <>
                    <Label>{ti("email")}</Label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={ti("emailPlaceholder")}
                      autoComplete="off"
                    />
                  </>
                )}
              />

              {/* Date of Birth & Nationality */}
              <TwoColumnFields
                left={(
                  <>
                    <Label>{ti("dateOfBirth")}</Label>
                    <Input
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => {
                        setDateOfBirth(e.target.value);
                        setDobError(null);
                      }}
                    />
                  </>
                )}
                right={(
                  <>
                    <Label>{ti("nationality")}</Label>
                    <Input
                      value={nationality}
                      onChange={(e) => setNationality(e.target.value)}
                      placeholder={ti("nationalityPlaceholder")}
                      autoComplete="off"
                    />
                  </>
                )}
              />
              {dobError && (
                <p className="text-sm text-destructive">{dobError}</p>
              )}

              {/* ID Number */}
              <div className="space-y-2">
                <Label>{ti("idNumber")}</Label>
                <VisibilityToggleInput
                  show={showIdNumber}
                  onToggle={() => setShowIdNumber(!showIdNumber)}
                  inputProps={{
                    value: idNumber,
                    onChange: (e) => setIdNumber(e.target.value),
                    placeholder: ti("idNumberPlaceholder"),
                    autoComplete: "off",
                  }}
                />
              </div>

              {/* Issue Date & Expiry Date */}
              <TwoColumnFields
                left={(
                  <>
                    <Label>{ti("issueDate")}</Label>
                    <Input
                      type="date"
                      value={issueDate}
                      onChange={(e) => {
                        setIssueDate(e.target.value);
                        setExpiryError(null);
                      }}
                    />
                  </>
                )}
                right={(
                  <>
                    <Label>{ti("expiryDate")}</Label>
                    <Input
                      type="date"
                      value={expiryDate}
                      onChange={(e) => {
                        setExpiryDate(e.target.value);
                        setExpiryError(null);
                      }}
                    />
                  </>
                )}
              />
              {expiryError && (
                <p className="text-sm text-destructive">{expiryError}</p>
              )}

              {/* Notes */}
              <div className="space-y-2">
                <Label>{entryCopy.notesLabel}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={entryCopy.notesPlaceholder}
                  rows={3}
                />
              </div>
            </>
          ) : isCreditCard ? (
            <>
              {/* Cardholder Name */}
              <div className="space-y-2">
                <Label>{tcc("cardholderName")}</Label>
                <Input
                  value={cardholderName}
                  onChange={(e) => setCardholderName(e.target.value)}
                  placeholder={tcc("cardholderNamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Brand */}
              <div className="space-y-2">
                <Label>{tcc("brand")}</Label>
                <Select
                  value={brand}
                  onValueChange={(value) => {
                    setBrand(value);
                    setBrandSource("manual");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={tcc("brandPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {CARD_BRANDS.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Card Number */}
              <div className="space-y-2">
                <Label>{tcc("cardNumber")}</Label>
                <VisibilityToggleInput
                  show={showCardNumber}
                  onToggle={() => setShowCardNumber(!showCardNumber)}
                  inputProps={{
                    value: cardNumber,
                    onChange: (e) => handleCardNumberChange(e.target.value),
                    placeholder: tcc("cardNumberPlaceholder"),
                    autoComplete: "off",
                    inputMode: "numeric",
                    maxLength: maxInputLength,
                    "aria-invalid": showLengthError || showLuhnError,
                  }}
                />
                {cardValidation.detectedBrand && (
                  <p className="text-xs text-muted-foreground">
                    {tcc("cardNumberDetectedBrand", { brand: cardValidation.detectedBrand })}
                  </p>
                )}
                {!hasBrandHint && cardValidation.digits.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {tcc("cardNumberLengthHintGeneric")}
                  </p>
                )}
                {hasBrandHint && (
                  <p className="text-xs text-muted-foreground">
                    {tcc("cardNumberLengthHint", { lengths: lengthHint })}
                  </p>
                )}
                {showLengthError && (
                  <p className="text-xs text-destructive">
                    {tcc("cardNumberInvalidLength", { lengths: lengthHint })}
                  </p>
                )}
                {!showLengthError && showLuhnError && (
                  <p className="text-xs text-destructive">
                    {tcc("cardNumberInvalidLuhn")}
                  </p>
                )}
              </div>

              {/* Expiry */}
              <TwoColumnFields
                left={(
                  <>
                    <Label>{tcc("expiry")}</Label>
                    <div className="flex gap-2">
                      <Select value={expiryMonth} onValueChange={setExpiryMonth}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={tcc("expiryMonth")} />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 12 }, (_, i) =>
                            String(i + 1).padStart(2, "0")
                          ).map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={expiryYear} onValueChange={setExpiryYear}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={tcc("expiryYear")} />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 15 }, (_, i) =>
                            String(new Date().getFullYear() + i)
                          ).map((y) => (
                            <SelectItem key={y} value={y}>
                              {y}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
                right={(
                  <>
                    <Label>{tcc("cvv")}</Label>
                    <VisibilityToggleInput
                      show={showCvv}
                      onToggle={() => setShowCvv(!showCvv)}
                      inputProps={{
                        value: cvv,
                        onChange: (e) => setCvv(e.target.value),
                        placeholder: tcc("cvvPlaceholder"),
                        autoComplete: "off",
                        maxLength: 4,
                      }}
                    />
                  </>
                )}
              />

              {/* Notes */}
              <div className="space-y-2">
                <Label>{entryCopy.notesLabel}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={entryCopy.notesPlaceholder}
                  rows={3}
                />
              </div>
            </>
          ) : isNote ? (
            <>
              {/* Content (Secure Note) */}
              <div className="space-y-2">
                <Label>{tn("content")}</Label>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={tn("contentPlaceholder")}
                  rows={10}
                  maxLength={50000}
                  className="font-mono"
                />
              </div>
            </>
          ) : (
            <>
              <EntryLoginMainFields
                idPrefix="org-"
                hideTitle
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
            </>
          )}

          <OrgTagSection
            title={entryCopy.tagsTitle}
            hint={t("tagsHint")}
            orgId={orgId}
            selectedTags={selectedTags}
            onChange={setSelectedTags}
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

        <EntryFolderSelectSection
          folders={orgFolders}
          value={orgFolderId}
          onChange={setOrgFolderId}
          sectionCardClass={dialogSectionClass}
        />

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
