"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TagData } from "@/components/tags/tag-input";
import { ArrowLeft } from "lucide-react";
import { CreditCardFields } from "@/components/entry-fields/credit-card-fields";
import {
  EntryActionBar,
  EntryPrimaryCard,
  ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry-form-ui";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry-tags-and-folder-section";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { preventIMESubmit } from "@/lib/ime-guard";
import { toTagPayload } from "@/components/passwords/entry-form-tags";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";

interface CreditCardFormProps {
  mode: "create" | "edit";
  initialData?: {
    id: string;
    title: string;
    cardholderName: string | null;
    cardNumber: string | null;
    brand: string | null;
    expiryMonth: string | null;
    expiryYear: string | null;
    cvv: string | null;
    notes: string | null;
    tags: TagData[];
    folderId?: string | null;
    requireReprompt?: boolean;
    expiresAt?: string | null;
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
  defaultFolderId?: string | null;
  defaultTags?: TagData[];
}

export function CreditCardForm({
  mode,
  initialData,
  variant = "page",
  onSaved,
  defaultFolderId,
  defaultTags,
}: CreditCardFormProps) {
  const t = useTranslations("CreditCardForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
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
  });
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [cardholderName, setCardholderName] = useState(
    initialData?.cardholderName ?? "",
  );
  const [cardNumber, setCardNumber] = useState(
    formatCardNumber(initialData?.cardNumber ?? "", initialData?.brand ?? ""),
  );
  const [brand, setBrand] = useState(initialData?.brand ?? "");
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(
    initialData?.brand ? "manual" : "auto",
  );
  const [expiryMonth, setExpiryMonth] = useState(initialData?.expiryMonth ?? "");
  const [expiryYear, setExpiryYear] = useState(initialData?.expiryYear ?? "");
  const [cvv, setCvv] = useState(initialData?.cvv ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        cardholderName: initialData?.cardholderName ?? "",
        cardNumber: formatCardNumber(
          initialData?.cardNumber ?? "",
          initialData?.brand ?? "",
        ),
        brand: initialData?.brand ?? "",
        expiryMonth: initialData?.expiryMonth ?? "",
        expiryYear: initialData?.expiryYear ?? "",
        cvv: initialData?.cvv ?? "",
        notes: initialData?.notes ?? "",
        selectedTagIds: (initialData?.tags ?? defaultTags ?? [])
          .map((tag) => tag.id)
          .sort(),
        folderId: initialData?.folderId ?? defaultFolderId ?? null,
        requireReprompt: initialData?.requireReprompt ?? false,
        expiresAt: initialData?.expiresAt ?? null,
      }),
    [initialData, defaultFolderId, defaultTags],
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: base.title,
        cardholderName,
        cardNumber,
        brand,
        expiryMonth,
        expiryYear,
        cvv,
        notes,
        selectedTagIds: base.selectedTags.map((tag) => tag.id).sort(),
        folderId: base.folderId,
        requireReprompt: base.requireReprompt,
        expiresAt: base.expiresAt,
      }),
    [
      base.title,
      cardholderName,
      cardNumber,
      brand,
      expiryMonth,
      expiryYear,
      cvv,
      notes,
      base.selectedTags,
      base.folderId,
      base.requireReprompt,
      base.expiresAt,
    ],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const primaryCardClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS
    : "";
  const dialogSectionClass = base.isDialogVariant
    ? ENTRY_DIALOG_FLAT_SECTION_CLASS
    : "";

  const validation = getCardNumberValidation(cardNumber, brand);
  const allowedLengths = getAllowedLengths(validation.effectiveBrand);
  const lengthHint = allowedLengths ? allowedLengths.join("/") : "12-19";
  const maxDigits = getMaxLength(
    validation.effectiveBrand || validation.detectedBrand,
  );
  const maxInputLength =
    validation.effectiveBrand === "American Express"
      ? maxDigits + 2
      : maxDigits + Math.floor((maxDigits - 1) / 4);
  const showLengthError = validation.digits.length > 0 && !validation.lengthValid;
  const showLuhnError =
    validation.digits.length > 0 &&
    validation.lengthValid &&
    !validation.luhnValid;
  const cardNumberValid =
    validation.digits.length === 0 ||
    (validation.lengthValid && validation.luhnValid);
  const hasBrandHint = Boolean(
    validation.effectiveBrand && validation.effectiveBrand !== "Other",
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardNumberValid) return;
    const tags = toTagPayload(base.selectedTags);
    const normalizedCardNumber = normalizeCardNumber(cardNumber);
    const lastFour = normalizedCardNumber ? normalizedCardNumber.slice(-4) : null;

    await base.submitEntry({
      t: tPw,
      fullBlob: JSON.stringify({
        title: base.title,
        cardholderName: cardholderName || null,
        cardNumber: normalizedCardNumber || null,
        brand: normalizeCardBrand(brand) || null,
        expiryMonth: expiryMonth || null,
        expiryYear: expiryYear || null,
        cvv: cvv || null,
        notes: notes || null,
        tags,
      }),
      overviewBlob: JSON.stringify({
        title: base.title,
        cardholderName: cardholderName || null,
        brand: normalizeCardBrand(brand) || null,
        lastFour,
        tags,
      }),
      entryType: ENTRY_TYPE.CREDIT_CARD,
    });
  };

  const handleCardNumberChange = (value: string) => {
    const digits = normalizeCardNumber(value);
    const detected = detectCardBrand(digits);
    const nextBrand = brandSource === "manual" ? brand : (detected || "");
    const formatted = formatCardNumber(digits, nextBrand || detected);

    setCardNumber(formatted);

    if (brandSource === "auto") {
      setBrand(detected);
    }
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

        <CreditCardFields
          cardholderName={cardholderName}
          onCardholderNameChange={setCardholderName}
          cardholderNamePlaceholder={t("cardholderNamePlaceholder")}
          brand={brand}
          onBrandChange={(v) => {
            setBrand(v);
            setBrandSource("manual");
          }}
          brandPlaceholder={t("brandPlaceholder")}
          brands={CARD_BRANDS}
          cardNumber={cardNumber}
          onCardNumberChange={handleCardNumberChange}
          cardNumberPlaceholder={t("cardNumberPlaceholder")}
          showCardNumber={showCardNumber}
          onToggleCardNumber={() => setShowCardNumber(!showCardNumber)}
          maxInputLength={maxInputLength}
          showLengthError={showLengthError}
          showLuhnError={showLuhnError}
          detectedBrand={
            validation.detectedBrand
              ? t("cardNumberDetectedBrand", { brand: validation.detectedBrand })
              : undefined
          }
          hasBrandHint={hasBrandHint}
          lengthHintGenericLabel={t("cardNumberLengthHintGeneric")}
          lengthHintLabel={t("cardNumberLengthHint", { lengths: lengthHint })}
          invalidLengthLabel={t("cardNumberInvalidLength", { lengths: lengthHint })}
          invalidLuhnLabel={t("cardNumberInvalidLuhn")}
          expiryMonth={expiryMonth}
          onExpiryMonthChange={setExpiryMonth}
          expiryYear={expiryYear}
          onExpiryYearChange={setExpiryYear}
          expiryMonthPlaceholder={t("expiryMonth")}
          expiryYearPlaceholder={t("expiryYear")}
          cvv={cvv}
          onCvvChange={setCvv}
          cvvPlaceholder={t("cvvPlaceholder")}
          showCvv={showCvv}
          onToggleCvv={() => setShowCvv(!showCvv)}
          notesLabel={t("notes")}
          notes={notes}
          onNotesChange={setNotes}
          notesPlaceholder={t("notesPlaceholder")}
          labels={{
            cardholderName: t("cardholderName"),
            brand: t("brand"),
            cardNumber: t("cardNumber"),
            expiry: t("expiry"),
            cvv: t("cvv"),
          }}
        />
      </EntryPrimaryCard>

      <EntryTagsAndFolderSection
        tagsTitle={t("tags")}
        tagsHint={tPw("tagsHint")}
        selectedTags={base.selectedTags}
        onTagsChange={base.setSelectedTags}
        folders={base.folders}
        folderId={base.folderId}
        onFolderChange={base.setFolderId}
        sectionCardClass={dialogSectionClass}
      />

      <EntryRepromptSection
        checked={base.requireReprompt}
        onCheckedChange={base.setRequireReprompt}
        title={tPw("requireReprompt")}
        description={tPw("requireRepromptHelp")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryExpirationSection
        value={base.expiresAt}
        onChange={base.setExpiresAt}
        title={tPw("expirationTitle")}
        description={tPw("expirationDescription")}
        sectionCardClass={dialogSectionClass}
      />

      <EntryActionBar
        hasChanges={hasChanges}
        submitting={base.submitting}
        submitDisabled={!cardNumberValid}
        saveLabel={mode === "create" ? tc("save") : tc("update")}
        cancelLabel={tc("cancel")}
        statusUnsavedLabel={tPw("statusUnsaved")}
        statusSavedLabel={tPw("statusSaved")}
        onCancel={base.handleCancel}
      />
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
            <CardTitle>{mode === "create" ? t("newCard") : t("editCard")}</CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
