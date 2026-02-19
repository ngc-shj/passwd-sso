"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NotesField, TwoColumnFields, VisibilityToggleInput } from "@/components/org/org-form-fields";

interface OrgCreditCardFieldsProps {
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  cardholderNamePlaceholder: string;
  brand: string;
  onBrandChange: (value: string) => void;
  brandPlaceholder: string;
  brands: readonly string[];
  cardNumber: string;
  onCardNumberChange: (value: string) => void;
  cardNumberPlaceholder: string;
  showCardNumber: boolean;
  onToggleCardNumber: () => void;
  maxInputLength: number;
  showLengthError: boolean;
  showLuhnError: boolean;
  detectedBrand?: string;
  hasBrandHint: boolean;
  lengthHintGenericLabel: string;
  lengthHintLabel: string;
  invalidLengthLabel: string;
  invalidLuhnLabel: string;
  expiryMonth: string;
  onExpiryMonthChange: (value: string) => void;
  expiryYear: string;
  onExpiryYearChange: (value: string) => void;
  expiryMonthPlaceholder: string;
  expiryYearPlaceholder: string;
  cvv: string;
  onCvvChange: (value: string) => void;
  cvvPlaceholder: string;
  showCvv: boolean;
  onToggleCvv: () => void;
  notesLabel: string;
  notes: string;
  onNotesChange: (value: string) => void;
  notesPlaceholder: string;
  labels: {
    cardholderName: string;
    brand: string;
    cardNumber: string;
    expiry: string;
    cvv: string;
  };
}

export function OrgCreditCardFields({
  cardholderName,
  onCardholderNameChange,
  cardholderNamePlaceholder,
  brand,
  onBrandChange,
  brandPlaceholder,
  brands,
  cardNumber,
  onCardNumberChange,
  cardNumberPlaceholder,
  showCardNumber,
  onToggleCardNumber,
  maxInputLength,
  showLengthError,
  showLuhnError,
  detectedBrand,
  hasBrandHint,
  lengthHintGenericLabel,
  lengthHintLabel,
  invalidLengthLabel,
  invalidLuhnLabel,
  expiryMonth,
  onExpiryMonthChange,
  expiryYear,
  onExpiryYearChange,
  expiryMonthPlaceholder,
  expiryYearPlaceholder,
  cvv,
  onCvvChange,
  cvvPlaceholder,
  showCvv,
  onToggleCvv,
  notesLabel,
  notes,
  onNotesChange,
  notesPlaceholder,
  labels,
}: OrgCreditCardFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>{labels.cardholderName}</Label>
        <Input
          value={cardholderName}
          onChange={(e) => onCardholderNameChange(e.target.value)}
          placeholder={cardholderNamePlaceholder}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label>{labels.brand}</Label>
        <Select value={brand} onValueChange={onBrandChange}>
          <SelectTrigger>
            <SelectValue placeholder={brandPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {brands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>{labels.cardNumber}</Label>
        <VisibilityToggleInput
          show={showCardNumber}
          onToggle={onToggleCardNumber}
          inputProps={{
            value: cardNumber,
            onChange: (e) => onCardNumberChange(e.target.value),
            placeholder: cardNumberPlaceholder,
            autoComplete: "off",
            inputMode: "numeric",
            maxLength: maxInputLength,
            "aria-invalid": showLengthError || showLuhnError,
          }}
        />
        {detectedBrand && (
          <p className="text-xs text-muted-foreground">{detectedBrand}</p>
        )}
        {!hasBrandHint && (
          <p className="text-xs text-muted-foreground">{lengthHintGenericLabel}</p>
        )}
        {hasBrandHint && (
          <p className="text-xs text-muted-foreground">{lengthHintLabel}</p>
        )}
        {showLengthError && (
          <p className="text-xs text-destructive">{invalidLengthLabel}</p>
        )}
        {!showLengthError && showLuhnError && (
          <p className="text-xs text-destructive">{invalidLuhnLabel}</p>
        )}
      </div>

      <TwoColumnFields
        left={(
          <>
            <Label>{labels.expiry}</Label>
            <div className="flex gap-2">
              <Select value={expiryMonth} onValueChange={onExpiryMonthChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={expiryMonthPlaceholder} />
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
              <Select value={expiryYear} onValueChange={onExpiryYearChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={expiryYearPlaceholder} />
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
            <Label>{labels.cvv}</Label>
            <VisibilityToggleInput
              show={showCvv}
              onToggle={onToggleCvv}
              inputProps={{
                value: cvv,
                onChange: (e) => onCvvChange(e.target.value),
                placeholder: cvvPlaceholder,
                autoComplete: "off",
                maxLength: 4,
              }}
            />
          </>
        )}
      />

      <NotesField
        label={notesLabel}
        value={notes}
        onChange={onNotesChange}
        placeholder={notesPlaceholder}
      />
    </>
  );
}
