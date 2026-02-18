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
import { PasswordGenerator } from "@/components/passwords/password-generator";
import { TOTPField, type TOTPEntry } from "@/components/passwords/totp-field";
import { OrgTagInput, type OrgTagData } from "./org-tag-input";
import { OrgAttachmentSection, type OrgAttachmentMeta } from "./org-attachment-section";
import {
  type GeneratorSettings,
  DEFAULT_GENERATOR_SETTINGS,
} from "@/lib/generator-prefs";
import { preventIMESubmit } from "@/lib/ime-guard";
import {
  Eye,
  EyeOff,
  Dices,
  Plus,
  X,
  ShieldCheck,
  Tags,
  Rows3,
  FolderOpen,
} from "lucide-react";
import { EntryActionBar, EntryPrimaryCard, EntrySectionCard } from "@/components/passwords/entry-form-ui";
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
  filterNonEmptyCustomFields,
} from "@/lib/entry-form-helpers";
import { ENTRY_TYPE, CUSTOM_FIELD_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue, CustomFieldType } from "@/lib/constants";
import type { FolderItem } from "@/components/folders/folder-tree";

export interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
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
    customFields?: CustomField[];
    totp?: TOTPEntry | null;
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
  const [customFields, setCustomFields] = useState<CustomField[]>(
    editData?.customFields ?? []
  );
  const [totp, setTotp] = useState<TOTPEntry | null>(
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
  const [orgFolders, setOrgFolders] = useState<FolderItem[]>([]);

  const isEdit = !!editData;

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
      setTitle(editData.title);
      setUsername(editData.username ?? "");
      setPassword(editData.password ?? "");
      setContent(editData.content ?? "");
      setUrl(editData.url ?? "");
      setNotes(editData.notes ?? "");
      setSelectedTags(editData.tags ?? []);
      setCustomFields(editData.customFields ?? []);
      setTotp(editData.totp ?? null);
      setShowTotpInput(!!editData.totp);
      setCardholderName(editData.cardholderName ?? "");
      setCardNumber(formatCardNumber(editData.cardNumber ?? "", editData.brand ?? ""));
      setBrand(editData.brand ?? "");
      setBrandSource(editData.brand ? "manual" : "auto");
      setExpiryMonth(editData.expiryMonth ?? "");
      setExpiryYear(editData.expiryYear ?? "");
      setCvv(editData.cvv ?? "");
      setFullName(editData.fullName ?? "");
      setAddress(editData.address ?? "");
      setPhone(editData.phone ?? "");
      setEmail(editData.email ?? "");
      setDateOfBirth(editData.dateOfBirth ?? "");
      setNationality(editData.nationality ?? "");
      setIdNumber(editData.idNumber ?? "");
      setIssueDate(editData.issueDate ?? "");
      setExpiryDate(editData.expiryDate ?? "");
      setRelyingPartyId(editData.relyingPartyId ?? "");
      setRelyingPartyName(editData.relyingPartyName ?? "");
      setCredentialId(editData.credentialId ?? "");
      setCreationDate(editData.creationDate ?? "");
      setDeviceInfo(editData.deviceInfo ?? "");
      setOrgFolderId(editData.orgFolderId ?? null);

      // Load attachments for edit mode
      fetch(apiPath.orgPasswordAttachments(orgId, editData.id))
        .then((res) => (res.ok ? res.json() : []))
        .then((loaded: OrgAttachmentMeta[]) => setAttachments(loaded))
        .catch(() => setAttachments([]));
    }
  }, [open, editData, orgId]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
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
    } else if (editData) {
      setTitle(editData.title);
      setUsername(editData.username ?? "");
      setPassword(editData.password);
      setContent(editData.content ?? "");
      setUrl(editData.url ?? "");
      setNotes(editData.notes ?? "");
      setSelectedTags(editData.tags ?? []);
      setCustomFields(editData.customFields ?? []);
      setTotp(editData.totp ?? null);
      setShowTotpInput(!!editData.totp);
      setCardholderName(editData.cardholderName ?? "");
      setCardNumber(formatCardNumber(editData.cardNumber ?? "", editData.brand ?? ""));
      setBrand(editData.brand ?? "");
      setBrandSource(editData.brand ? "manual" : "auto");
      setExpiryMonth(editData.expiryMonth ?? "");
      setExpiryYear(editData.expiryYear ?? "");
      setCvv(editData.cvv ?? "");
      setFullName(editData.fullName ?? "");
      setAddress(editData.address ?? "");
      setPhone(editData.phone ?? "");
      setEmail(editData.email ?? "");
      setDateOfBirth(editData.dateOfBirth ?? "");
      setNationality(editData.nationality ?? "");
      setIdNumber(editData.idNumber ?? "");
      setIssueDate(editData.issueDate ?? "");
      setExpiryDate(editData.expiryDate ?? "");
      setRelyingPartyId(editData.relyingPartyId ?? "");
      setRelyingPartyName(editData.relyingPartyName ?? "");
      setCredentialId(editData.credentialId ?? "");
      setCreationDate(editData.creationDate ?? "");
      setDeviceInfo(editData.deviceInfo ?? "");
      setOrgFolderId(editData.orgFolderId ?? null);
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
    if (isPasskey) {
      if (!title.trim() || !relyingPartyId.trim()) return;
    } else if (isCreditCard) {
      if (!title.trim()) return;
      if (!cardNumberValid) return;
    } else if (isIdentity) {
      if (!title.trim()) return;
      let hasDateError = false;
      if (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10)) {
        setDobError(ti("dobFuture"));
        hasDateError = true;
      } else {
        setDobError(null);
      }
      if (issueDate && expiryDate && issueDate >= expiryDate) {
        setExpiryError(ti("expiryBeforeIssue"));
        hasDateError = true;
      } else {
        setExpiryError(null);
      }
      if (hasDateError) return;
    } else if (isNote) {
      if (!title.trim()) return;
    } else {
      if (!title.trim() || !password) return;
    }
    setSaving(true);

    try {
      const endpoint = isEdit
        ? apiPath.orgPasswordById(orgId, editData.id)
        : apiPath.orgPasswords(orgId);
      const tagIds = extractTagIds(selectedTags);

      let body: Record<string, unknown>;

      if (isPasskey) {
        body = {
          entryType: ENTRY_TYPE.PASSKEY,
          title: title.trim(),
          relyingPartyId: relyingPartyId.trim(),
          relyingPartyName: relyingPartyName.trim() || undefined,
          username: username.trim() || undefined,
          credentialId: credentialId.trim() || undefined,
          creationDate: creationDate || undefined,
          deviceInfo: deviceInfo.trim() || undefined,
          notes: notes.trim() || undefined,
          tagIds,
          orgFolderId: orgFolderId ?? null,
        };
      } else if (isIdentity) {
        body = {
          entryType: ENTRY_TYPE.IDENTITY,
          title: title.trim(),
          fullName: fullName.trim() || undefined,
          address: address.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          dateOfBirth: dateOfBirth || undefined,
          nationality: nationality.trim() || undefined,
          idNumber: idNumber.trim() || undefined,
          issueDate: issueDate || undefined,
          expiryDate: expiryDate || undefined,
          notes: notes.trim() || undefined,
          tagIds,
          orgFolderId: orgFolderId ?? null,
        };
      } else if (isCreditCard) {
        body = {
          entryType: ENTRY_TYPE.CREDIT_CARD,
          title: title.trim(),
          cardholderName: cardholderName.trim() || undefined,
          cardNumber: normalizeCardNumber(cardNumber) || undefined,
          brand: normalizeCardBrand(brand) || undefined,
          expiryMonth: expiryMonth || undefined,
          expiryYear: expiryYear || undefined,
          cvv: cvv || undefined,
          notes: notes.trim() || undefined,
          tagIds,
          orgFolderId: orgFolderId ?? null,
        };
      } else if (isNote) {
        body = {
          entryType: ENTRY_TYPE.SECURE_NOTE,
          title: title.trim(),
          content,
          tagIds,
          orgFolderId: orgFolderId ?? null,
        };
      } else {
        body = {
          title: title.trim(),
          username: username.trim() || undefined,
          password,
          url: url.trim() || undefined,
          notes: notes.trim() || undefined,
          tagIds,
          orgFolderId: orgFolderId ?? null,
        };

        const validFields = filterNonEmptyCustomFields(customFields);
        if (validFields.length > 0) {
          body.customFields = validFields;
        }
        if (totp) {
          body.totp = totp;
        } else {
          body.totp = null;
        }
      }

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

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handleSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isPasskey
              ? (isEdit ? tpk("editPasskey") : tpk("newPasskey"))
              : isIdentity
                ? (isEdit ? ti("editIdentity") : ti("newIdentity"))
                : isCreditCard
                  ? (isEdit ? tcc("editCard") : tcc("newCard"))
                  : isNote
                    ? (isEdit ? tn("editNote") : tn("newNote"))
                    : (isEdit ? t("editPassword") : t("newPassword"))}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isPasskey
              ? (isEdit ? tpk("editPasskey") : tpk("newPasskey"))
              : isIdentity
                ? (isEdit ? ti("editIdentity") : ti("newIdentity"))
                : isCreditCard
                  ? (isEdit ? tcc("editCard") : tcc("newCard"))
                  : isNote
                    ? (isEdit ? tn("editNote") : tn("newNote"))
                    : (isEdit ? t("editPassword") : t("newPassword"))}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleFormSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
          <EntryPrimaryCard>
          {/* Title */}
          <div className="space-y-2">
            <Label>{isPasskey ? tpk("title") : isIdentity ? ti("title") : isCreditCard ? tcc("title") : isNote ? tn("title") : t("title")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isPasskey ? tpk("titlePlaceholder") : isIdentity ? ti("titlePlaceholder") : isCreditCard ? tcc("titlePlaceholder") : isNote ? tn("titlePlaceholder") : t("titlePlaceholder")}
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
                <div className="relative">
                  <Input
                    type={showCredentialId ? "text" : "password"}
                    value={credentialId}
                    onChange={(e) => setCredentialId(e.target.value)}
                    placeholder={tpk("credentialIdPlaceholder")}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowCredentialId(!showCredentialId)}
                  >
                    {showCredentialId ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Creation Date & Device Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tpk("creationDate")}</Label>
                  <Input
                    type="date"
                    value={creationDate}
                    onChange={(e) => setCreationDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tpk("deviceInfo")}</Label>
                  <Input
                    value={deviceInfo}
                    onChange={(e) => setDeviceInfo(e.target.value)}
                    placeholder={tpk("deviceInfoPlaceholder")}
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label>{tpk("notes")}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={tpk("notesPlaceholder")}
                  rows={3}
                />
              </div>

              {/* Tags */}
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    {tpk("tags")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
                </div>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </EntrySectionCard>
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
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{ti("phone")}</Label>
                  <Input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={ti("phonePlaceholder")}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{ti("email")}</Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={ti("emailPlaceholder")}
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* Date of Birth & Nationality */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{ti("dateOfBirth")}</Label>
                  <Input
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => {
                      setDateOfBirth(e.target.value);
                      setDobError(null);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{ti("nationality")}</Label>
                  <Input
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                    placeholder={ti("nationalityPlaceholder")}
                    autoComplete="off"
                  />
                </div>
              </div>
              {dobError && (
                <p className="text-sm text-destructive">{dobError}</p>
              )}

              {/* ID Number */}
              <div className="space-y-2">
                <Label>{ti("idNumber")}</Label>
                <div className="relative">
                  <Input
                    type={showIdNumber ? "text" : "password"}
                    value={idNumber}
                    onChange={(e) => setIdNumber(e.target.value)}
                    placeholder={ti("idNumberPlaceholder")}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowIdNumber(!showIdNumber)}
                  >
                    {showIdNumber ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Issue Date & Expiry Date */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{ti("issueDate")}</Label>
                  <Input
                    type="date"
                    value={issueDate}
                    onChange={(e) => {
                      setIssueDate(e.target.value);
                      setExpiryError(null);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{ti("expiryDate")}</Label>
                  <Input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => {
                      setExpiryDate(e.target.value);
                      setExpiryError(null);
                    }}
                  />
                </div>
              </div>
              {expiryError && (
                <p className="text-sm text-destructive">{expiryError}</p>
              )}

              {/* Notes */}
              <div className="space-y-2">
                <Label>{ti("notes")}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={ti("notesPlaceholder")}
                  rows={3}
                />
              </div>

              {/* Tags */}
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    {ti("tags")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
                </div>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </EntrySectionCard>
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
                <div className="relative">
                  <Input
                    type={showCardNumber ? "text" : "password"}
                    value={cardNumber}
                    onChange={(e) => handleCardNumberChange(e.target.value)}
                    placeholder={tcc("cardNumberPlaceholder")}
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={maxInputLength}
                    aria-invalid={showLengthError || showLuhnError}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowCardNumber(!showCardNumber)}
                  >
                    {showCardNumber ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
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
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
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
                </div>

                {/* CVV */}
                <div className="space-y-2">
                  <Label>{tcc("cvv")}</Label>
                  <div className="relative">
                    <Input
                      type={showCvv ? "text" : "password"}
                      value={cvv}
                      onChange={(e) => setCvv(e.target.value)}
                      placeholder={tcc("cvvPlaceholder")}
                      autoComplete="off"
                      maxLength={4}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowCvv(!showCvv)}
                    >
                      {showCvv ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label>{tcc("notes")}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={tcc("notesPlaceholder")}
                  rows={3}
                />
              </div>

              {/* Tags */}
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    {tcc("tags")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
                </div>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </EntrySectionCard>
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

              {/* Tags (org tags) */}
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    {tn("tags")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
                </div>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </EntrySectionCard>
            </>
          ) : (
            <>
              {/* Username */}
              <div className="space-y-2">
                <Label>{t("usernameEmail")}</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("usernamePlaceholder")}
                  autoComplete="off"
                />
              </div>

              {/* Password with show/hide and generator */}
              <div className="space-y-2 rounded-lg border bg-background/70 p-3">
                <Label>{t("password")}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("passwordPlaceholder")}
                      autoComplete="off"
                    />
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{generatorSummary}</p>
                  <Button
                    type="button"
                    variant={showGenerator ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => setShowGenerator((v) => !v)}
                  >
                    <Dices className="h-3.5 w-3.5" />
                    {showGenerator ? t("closeGenerator") : t("openGenerator")}
                  </Button>
                </div>
                <PasswordGenerator
                  open={showGenerator}
                  onClose={() => setShowGenerator(false)}
                  settings={generatorSettings}
                  onUse={(pw, settings) => {
                    setPassword(pw);
                    setShowPassword(true);
                    setGeneratorSettings(settings);
                  }}
                />
              </div>

              {/* URL */}
              <div className="space-y-2">
                <Label>{t("url")}</Label>
                <Input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                />
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label>{t("notes")}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("notesPlaceholder")}
                  rows={3}
                />
              </div>

              {/* Tags (org tags) */}
              <EntrySectionCard>
                <div className="space-y-1">
                  <Label className="flex items-center gap-2">
                    <Tags className="h-3.5 w-3.5" />
                    {t("tags")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
                </div>
                <OrgTagInput
                  orgId={orgId}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                />
              </EntrySectionCard>

              {/* Custom Fields */}
              <EntrySectionCard>
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-2">
                      <Rows3 className="h-3.5 w-3.5" />
                      {t("customFields")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("customFieldsHint")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() =>
                      setCustomFields((prev) => [
                        ...prev,
                        { label: "", value: "", type: CUSTOM_FIELD_TYPE.TEXT },
                      ])
                    }
                  >
                    <Plus className="h-3 w-3" />
                    {t("addField")}
                  </Button>
                </div>
                {customFields.map((field, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2 rounded-lg border p-2"
                  >
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={field.label}
                          onChange={(e) =>
                            setCustomFields((prev) =>
                              prev.map((f, i) =>
                                i === idx ? { ...f, label: e.target.value } : f
                              )
                            )
                          }
                          placeholder={t("fieldLabel")}
                          className="h-8 text-sm"
                        />
                        <Select
                          value={field.type}
                          onValueChange={(v: CustomFieldType) =>
                            setCustomFields((prev) =>
                              prev.map((f, i) =>
                                i === idx ? { ...f, type: v } : f
                              )
                            )
                          }
                        >
                          <SelectTrigger className="h-8 w-28 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={CUSTOM_FIELD_TYPE.TEXT}>{t("fieldText")}</SelectItem>
                            <SelectItem value={CUSTOM_FIELD_TYPE.HIDDEN}>
                              {t("fieldHidden")}
                            </SelectItem>
                            <SelectItem value={CUSTOM_FIELD_TYPE.URL}>{t("fieldUrl")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        type={
                          field.type === CUSTOM_FIELD_TYPE.HIDDEN
                            ? "password"
                            : field.type === CUSTOM_FIELD_TYPE.URL
                              ? "url"
                              : "text"
                        }
                        value={field.value}
                        onChange={(e) =>
                          setCustomFields((prev) =>
                            prev.map((f, i) =>
                              i === idx ? { ...f, value: e.target.value } : f
                            )
                          )
                        }
                        placeholder={t("fieldValue")}
                        className="h-8 text-sm"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setCustomFields((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </EntrySectionCard>

              {/* TOTP */}
              <EntrySectionCard>
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {t("totp")}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t("totpHint")}</p>
                  </div>
                  {!showTotpInput && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => setShowTotpInput(true)}
                    >
                      <Plus className="h-3 w-3" />
                      {t("addTotp")}
                    </Button>
                  )}
                </div>
                {showTotpInput && (
                  <TOTPField
                    mode="input"
                    totp={totp}
                    onChange={setTotp}
                    onRemove={() => setShowTotpInput(false)}
                  />
                )}
              </EntrySectionCard>
            </>
          )}
          </EntryPrimaryCard>

        {/* Folder assignment */}
        {orgFolders.length > 0 && (
          <EntrySectionCard>
            <div className="space-y-1">
              <Label className="flex items-center gap-2">
                <FolderOpen className="h-3.5 w-3.5" />
                {t("folder")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("folderHint")}</p>
            </div>
            <Select
              value={orgFolderId ?? "__none__"}
              onValueChange={(v) => setOrgFolderId(v === "__none__" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("noFolder")}</SelectItem>
                {orgFolders.map((f) => {
                  let depth = 0;
                  let current: FolderItem | undefined = f;
                  while (current?.parentId) {
                    depth++;
                    current = orgFolders.find((p) => p.id === current!.parentId);
                  }
                  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
                  return (
                    <SelectItem key={f.id} value={f.id}>
                      {indent}{f.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </EntrySectionCard>
        )}

        {/* Actions */}
        <EntryActionBar
          hasChanges={hasChanges}
          submitting={saving}
          submitDisabled={
            !title.trim() ||
            (isPasskey && !relyingPartyId.trim()) ||
            (!isNote && !isCreditCard && !isIdentity && !isPasskey && !password) ||
            (isCreditCard && !cardNumberValid)
          }
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
