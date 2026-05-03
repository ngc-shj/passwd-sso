// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CREDIT_CARD_CVC_MAX_LENGTH } from "@/lib/validations/common";
import { CreditCardFields } from "./credit-card-fields";

const baseProps = {
  cardholderName: "",
  onCardholderNameChange: vi.fn(),
  cardholderNamePlaceholder: "HolderPH",
  brand: "",
  onBrandChange: vi.fn(),
  brandPlaceholder: "BrandPH",
  brands: ["Visa", "Mastercard"] as readonly string[],
  cardNumber: "",
  onCardNumberChange: vi.fn(),
  cardNumberPlaceholder: "NumberPH",
  showCardNumber: false,
  onToggleCardNumber: vi.fn(),
  maxInputLength: 19,
  showLengthError: false,
  showLuhnError: false,
  hasBrandHint: false,
  lengthHintGenericLabel: "lenHintGeneric",
  lengthHintLabel: "lenHint",
  invalidLengthLabel: "invalidLen",
  invalidLuhnLabel: "invalidLuhn",
  expiryMonth: "01",
  onExpiryMonthChange: vi.fn(),
  expiryYear: "2030",
  onExpiryYearChange: vi.fn(),
  expiryMonthPlaceholder: "MM",
  expiryYearPlaceholder: "YYYY",
  cvv: "",
  onCvvChange: vi.fn(),
  cvvPlaceholder: "CvvPH",
  showCvv: false,
  onToggleCvv: vi.fn(),
  notesLabel: "Notes",
  notes: "",
  onNotesChange: vi.fn(),
  notesPlaceholder: "NotesPH",
  labels: {
    cardholderName: "Cardholder",
    brand: "Brand",
    cardNumber: "Number",
    expiry: "Expiry",
    cvv: "CVV",
  },
};

describe("CreditCardFields", () => {
  it("renders the generic length hint when hasBrandHint=false", () => {
    render(<CreditCardFields {...baseProps} hasBrandHint={false} />);
    expect(screen.getByText("lenHintGeneric")).toBeInTheDocument();
    expect(screen.queryByText("lenHint")).toBeNull();
  });

  it("renders the brand-specific length hint when hasBrandHint=true", () => {
    render(<CreditCardFields {...baseProps} hasBrandHint={true} />);
    expect(screen.getByText("lenHint")).toBeInTheDocument();
    expect(screen.queryByText("lenHintGeneric")).toBeNull();
  });

  it("renders length error and suppresses Luhn error when both flags are true", () => {
    render(
      <CreditCardFields {...baseProps} showLengthError={true} showLuhnError={true} />,
    );
    expect(screen.getByText("invalidLen")).toBeInTheDocument();
    expect(screen.queryByText("invalidLuhn")).toBeNull();
  });

  it("renders Luhn error when only Luhn fails", () => {
    render(
      <CreditCardFields {...baseProps} showLengthError={false} showLuhnError={true} />,
    );
    expect(screen.getByText("invalidLuhn")).toBeInTheDocument();
  });

  it("renders detectedBrand when supplied", () => {
    render(<CreditCardFields {...baseProps} detectedBrand="Visa (detected)" />);
    expect(screen.getByText("Visa (detected)")).toBeInTheDocument();
  });

  it("propagates onCardNumberChange to consumer", () => {
    const onCardNumberChange = vi.fn();
    render(
      <CreditCardFields {...baseProps} onCardNumberChange={onCardNumberChange} />,
    );
    fireEvent.change(screen.getByPlaceholderText("NumberPH"), {
      target: { value: "4111" },
    });
    expect(onCardNumberChange).toHaveBeenCalledWith("4111");
  });

  it("applies CREDIT_CARD_CVC_MAX_LENGTH to the CVV input (RT3)", () => {
    render(<CreditCardFields {...baseProps} />);
    expect(screen.getByPlaceholderText("CvvPH")).toHaveAttribute(
      "maxLength",
      String(CREDIT_CARD_CVC_MAX_LENGTH),
    );
  });
});
