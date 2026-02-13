"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
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
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagInput, type TagData } from "@/components/tags/tag-input";
import { ArrowLeft, Eye, EyeOff, Tags } from "lucide-react";
import { EntryActionBar, EntryPrimaryCard, EntrySectionCard } from "@/components/passwords/entry-form-ui";
import { toast } from "sonner";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";

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
  };
  variant?: "page" | "dialog";
  onSaved?: () => void;
}

export function CreditCardForm({ mode, initialData, variant = "page", onSaved }: CreditCardFormProps) {
  const t = useTranslations("CreditCardForm");
  const tPw = useTranslations("PasswordForm");
  const tc = useTranslations("Common");
  const router = useRouter();
  const { encryptionKey, userId } = useVault();
  const [submitting, setSubmitting] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);

  const [title, setTitle] = useState(initialData?.title ?? "");
  const [cardholderName, setCardholderName] = useState(initialData?.cardholderName ?? "");
  const [cardNumber, setCardNumber] = useState(
    formatCardNumber(initialData?.cardNumber ?? "", initialData?.brand ?? "")
  );
  const [brand, setBrand] = useState(initialData?.brand ?? "");
  const [brandSource, setBrandSource] = useState<"auto" | "manual">(
    initialData?.brand ? "manual" : "auto"
  );
  const [expiryMonth, setExpiryMonth] = useState(initialData?.expiryMonth ?? "");
  const [expiryYear, setExpiryYear] = useState(initialData?.expiryYear ?? "");
  const [cvv, setCvv] = useState(initialData?.cvv ?? "");
  const [notes, setNotes] = useState(initialData?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<TagData[]>(
    initialData?.tags ?? []
  );

  const baselineSnapshot = useMemo(
    () =>
      JSON.stringify({
        title: initialData?.title ?? "",
        cardholderName: initialData?.cardholderName ?? "",
        cardNumber: formatCardNumber(initialData?.cardNumber ?? "", initialData?.brand ?? ""),
        brand: initialData?.brand ?? "",
        expiryMonth: initialData?.expiryMonth ?? "",
        expiryYear: initialData?.expiryYear ?? "",
        cvv: initialData?.cvv ?? "",
        notes: initialData?.notes ?? "",
        selectedTagIds: (initialData?.tags ?? []).map((tag) => tag.id).sort(),
      }),
    [initialData]
  );

  const currentSnapshot = useMemo(
    () =>
      JSON.stringify({
        title,
        cardholderName,
        cardNumber,
        brand,
        expiryMonth,
        expiryYear,
        cvv,
        notes,
        selectedTagIds: selectedTags.map((tag) => tag.id).sort(),
      }),
    [
      title,
      cardholderName,
      cardNumber,
      brand,
      expiryMonth,
      expiryYear,
      cvv,
      notes,
      selectedTags,
    ]
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;

  const validation = getCardNumberValidation(cardNumber, brand);
  const allowedLengths = getAllowedLengths(validation.effectiveBrand);
  const lengthHint = allowedLengths
    ? allowedLengths.join("/")
    : "12-19";
  const maxDigits = getMaxLength(validation.effectiveBrand || validation.detectedBrand);
  const maxInputLength =
    validation.effectiveBrand === "American Express"
      ? maxDigits + 2
      : maxDigits + Math.floor((maxDigits - 1) / 4);
  const showLengthError = validation.digits.length > 0 && !validation.lengthValid;
  const showLuhnError =
    validation.digits.length > 0 && validation.lengthValid && !validation.luhnValid;
  const cardNumberValid =
    validation.digits.length === 0 || (validation.lengthValid && validation.luhnValid);
  const hasBrandHint = Boolean(validation.effectiveBrand && validation.effectiveBrand !== "Other");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptionKey) return;
    if (!cardNumberValid) return;
    setSubmitting(true);

    try {
      const tags = selectedTags.map((t) => ({
        name: t.name,
        color: t.color,
      }));

      const normalizedCardNumber = normalizeCardNumber(cardNumber);
      const lastFour = normalizedCardNumber ? normalizedCardNumber.slice(-4) : null;

      const fullBlob = JSON.stringify({
        title,
        cardholderName: cardholderName || null,
        cardNumber: normalizedCardNumber || null,
        brand: normalizeCardBrand(brand) || null,
        expiryMonth: expiryMonth || null,
        expiryYear: expiryYear || null,
        cvv: cvv || null,
        notes: notes || null,
        tags,
      });

      const overviewBlob = JSON.stringify({
        title,
        cardholderName: cardholderName || null,
        brand: normalizeCardBrand(brand) || null,
        lastFour,
        tags,
      });

      const entryId = mode === "create" ? crypto.randomUUID() : initialData!.id;
      const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;

      const encryptedBlob = await encryptData(fullBlob, encryptionKey, aad);
      const encryptedOverview = await encryptData(overviewBlob, encryptionKey, aad);

      const body = {
        ...(mode === "create" ? { id: entryId } : {}),
        encryptedBlob,
        encryptedOverview,
        keyVersion: 1,
        aadVersion: aad ? AAD_VERSION : 0,
        tagIds: selectedTags.map((t) => t.id),
        entryType: ENTRY_TYPE.CREDIT_CARD,
      };

      const endpoint =
        mode === "create"
          ? API_PATH.PASSWORDS
          : apiPath.passwordById(initialData!.id);
      const method = mode === "create" ? "POST" : "PUT";

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(mode === "create" ? t("saved") : t("updated"));
        if (onSaved) {
          onSaved();
        } else {
          router.push("/dashboard");
          router.refresh();
        }
      } else {
        toast.error(t("failedToSave"));
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (onSaved) {
      onSaved();
    } else {
      router.back();
    }
  };

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

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-5">
      <EntryPrimaryCard>
      <div className="space-y-2">
        <Label htmlFor="title">{t("title")}</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cardholderName">{t("cardholderName")}</Label>
        <Input
          id="cardholderName"
          value={cardholderName}
          onChange={(e) => setCardholderName(e.target.value)}
          placeholder={t("cardholderNamePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{t("brand")}</Label>
        <Select
          value={brand}
          onValueChange={(value) => {
            setBrand(value);
            setBrandSource("manual");
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("brandPlaceholder")} />
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

      <div className="space-y-2">
        <Label htmlFor="cardNumber">{t("cardNumber")}</Label>
        <div className="relative">
          <Input
            id="cardNumber"
            type={showCardNumber ? "text" : "password"}
            value={cardNumber}
            onChange={(e) => handleCardNumberChange(e.target.value)}
            placeholder={t("cardNumberPlaceholder")}
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
        {validation.detectedBrand && (
          <p className="text-xs text-muted-foreground">
            {t("cardNumberDetectedBrand", { brand: validation.detectedBrand })}
          </p>
        )}
        {!hasBrandHint && validation.digits.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("cardNumberLengthHintGeneric")}
          </p>
        )}
        {hasBrandHint && (
          <p className="text-xs text-muted-foreground">
            {t("cardNumberLengthHint", { lengths: lengthHint })}
          </p>
        )}
        {showLengthError && (
          <p className="text-xs text-destructive">
            {t("cardNumberInvalidLength", { lengths: lengthHint })}
          </p>
        )}
        {!showLengthError && showLuhnError && (
          <p className="text-xs text-destructive">
            {t("cardNumberInvalidLuhn")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("expiry")}</Label>
          <div className="flex gap-2">
            <Select value={expiryMonth} onValueChange={setExpiryMonth}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("expiryMonth")} />
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
                <SelectValue placeholder={t("expiryYear")} />
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

        <div className="space-y-2">
          <Label htmlFor="cvv">{t("cvv")}</Label>
          <div className="relative">
            <Input
              id="cvv"
              type={showCvv ? "text" : "password"}
              value={cvv}
              onChange={(e) => setCvv(e.target.value)}
              placeholder={t("cvvPlaceholder")}
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

      <div className="space-y-2">
        <Label htmlFor="notes">{t("notes")}</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("notesPlaceholder")}
          rows={3}
        />
      </div>

      </EntryPrimaryCard>

      <EntrySectionCard>
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <Tags className="h-3.5 w-3.5" />
            {t("tags")}
          </Label>
          <p className="text-xs text-muted-foreground">{tPw("tagsHint")}</p>
        </div>
        <TagInput
          selectedTags={selectedTags}
          onChange={setSelectedTags}
        />
      </EntrySectionCard>

      <EntryActionBar
        hasChanges={hasChanges}
        submitting={submitting}
        submitDisabled={!cardNumberValid}
        saveLabel={mode === "create" ? tc("save") : tc("update")}
        cancelLabel={tc("cancel")}
        statusUnsavedLabel={tPw("statusUnsaved")}
        statusSavedLabel={tPw("statusSaved")}
        onCancel={handleCancel}
      />
    </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-6">
      <Button
        variant="ghost"
        className="mb-4 gap-2"
        onClick={() => router.back()}
      >
        <ArrowLeft className="h-4 w-4" />
        {tc("back")}
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "create" ? t("newCard") : t("editCard")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {formContent}
        </CardContent>
      </Card>
    </div>
  );
}
