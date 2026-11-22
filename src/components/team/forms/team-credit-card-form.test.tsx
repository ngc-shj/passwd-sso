// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { mockSubmitEntry, mockHandleOpenChange, baseConfig } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
  mockHandleOpenChange: vi.fn(),
  baseConfig: { isEdit: false, initialTitle: "", requireRepromptForAll: false },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("@/lib/ui/ime-guard", () => ({ preventIMESubmit: vi.fn() }));

// The base hook owns crypto, policy fetch and save; it is tested on its own.
// Here it is a stateful stand-in so the form's own wiring is exercised.
vi.mock("@/hooks/team/use-team-base-form-model", async () => {
  const { useState } = await import("react");
  return {
    useTeamBaseFormModel: () => {
      const [title, setTitle] = useState(baseConfig.initialTitle);
      const [notes, setNotes] = useState("");
      return {
        t: (k: string) => k,
        tc: (k: string) => k,
        isEdit: baseConfig.isEdit,
        saving: false,
        title,
        setTitle,
        notes,
        setNotes,
        selectedTags: [{ id: "tag-1", name: "work", color: "#f00" }],
        setSelectedTags: vi.fn(),
        teamFolders: [],
        teamFolderId: null,
        setTeamFolderId: vi.fn(),
        requireReprompt: false,
        setRequireReprompt: vi.fn(),
        travelSafe: false,
        setTravelSafe: vi.fn(),
        expiresAt: null,
        setExpiresAt: vi.fn(),
        teamPolicy: { requireRepromptForAll: baseConfig.requireRepromptForAll },
        attachments: [],
        setAttachments: vi.fn(),
        submitEntry: mockSubmitEntry,
        handleOpenChange: mockHandleOpenChange,
        entryCopy: {
          titleLabel: "title",
          titlePlaceholder: "title-ph",
          notesLabel: "notes",
          notesPlaceholder: "notes-ph",
          tagsTitle: "tags",
        },
      };
    },
  };
});

vi.mock("@/components/team/forms/team-tags-and-folder-section", () => ({
  TeamTagsAndFolderSection: () => null,
}));
vi.mock("@/components/passwords/entry/entry-reprompt-section", () => ({
  EntryRepromptSection: ({ policyForcedLabel }: { policyForcedLabel?: string }) =>
    policyForcedLabel ? <p>{policyForcedLabel}</p> : null,
}));
vi.mock("@/components/passwords/entry/entry-travel-safe-section", () => ({
  EntryTravelSafeSection: () => null,
}));
vi.mock("@/components/passwords/entry/entry-expiration-section", () => ({
  EntryExpirationSection: () => null,
}));
vi.mock("./team-attachment-section", () => ({
  TeamAttachmentSection: ({ entryId }: { entryId: string }) => (
    <div data-testid="attachments">{entryId}</div>
  ),
}));

// The real fields use Radix selects for brand and expiry; a stand-in exposes
// each handler as a plain input so the form's own wiring can be driven.
vi.mock("@/components/entry-fields/credit-card-fields", () => {
  type FieldProps = {
    cardholderName: string;
    onCardholderNameChange: (v: string) => void;
    brand: string;
    onBrandChange: (v: string) => void;
    cardNumber: string;
    onCardNumberChange: (v: string) => void;
    showCardNumber: boolean;
    onToggleCardNumber: () => void;
    showLengthError: boolean;
    showLuhnError: boolean;
    detectedBrand?: string;
    hasBrandHint: boolean;
    lengthHintGenericLabel: string;
    lengthHintLabel: string;
    invalidLengthLabel: string;
    invalidLuhnLabel: string;
    expiryMonth: string;
    onExpiryMonthChange: (v: string) => void;
    expiryYear: string;
    onExpiryYearChange: (v: string) => void;
    cvv: string;
    onCvvChange: (v: string) => void;
    showCvv: boolean;
    onToggleCvv: () => void;
  };
  return {
    CreditCardFields: (p: FieldProps) => (
      <div>
        <input aria-label="cardholderName" value={p.cardholderName} onChange={(e) => p.onCardholderNameChange(e.target.value)} />
        <input aria-label="brand" value={p.brand} onChange={(e) => p.onBrandChange(e.target.value)} />
        <input
          aria-label="cardNumber"
          type={p.showCardNumber ? "text" : "password"}
          value={p.cardNumber}
          onChange={(e) => p.onCardNumberChange(e.target.value)}
        />
        <button type="button" onClick={p.onToggleCardNumber}>toggle-card-number</button>
        {p.detectedBrand && <p>{p.detectedBrand}</p>}
        <p>{p.hasBrandHint ? p.lengthHintLabel : p.lengthHintGenericLabel}</p>
        {p.showLengthError && <p>{p.invalidLengthLabel}</p>}
        {p.showLuhnError && <p>{p.invalidLuhnLabel}</p>}
        <input aria-label="expiryMonth" value={p.expiryMonth} onChange={(e) => p.onExpiryMonthChange(e.target.value)} />
        <input aria-label="expiryYear" value={p.expiryYear} onChange={(e) => p.onExpiryYearChange(e.target.value)} />
        <input
          aria-label="cvv"
          type={p.showCvv ? "text" : "password"}
          value={p.cvv}
          onChange={(e) => p.onCvvChange(e.target.value)}
        />
        <button type="button" onClick={p.onToggleCvv}>toggle-cvv</button>
      </div>
    ),
  };
});

import { TeamCreditCardForm } from "./team-credit-card-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.CREDIT_CARD,
};

const editData: TeamEntryFormEditData = {
  id: "entry-4",
  title: "Corporate card",
  username: null,
  password: "",
  url: null,
  notes: null,
  cardholderName: "Acme Inc",
  cardNumber: "4111 1111 1111 1111",
  brand: "Visa",
  expiryMonth: "12",
  expiryYear: "2030",
  cvv: "123",
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function setTitle(value: string) {
  fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value } });
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "save" }));
}

function resetBase() {
  vi.clearAllMocks();
  baseConfig.isEdit = false;
  baseConfig.initialTitle = "";
  baseConfig.requireRepromptForAll = false;
  mockSubmitEntry.mockResolvedValue(undefined);
}

describe("TeamCreditCardForm", () => {
  beforeEach(resetBase);

  it("submits a credit-card payload with the formatted number and the detected brand", async () => {
    render(<TeamCreditCardForm {...baseProps} />);
    setTitle("Corporate card");
    type("cardholderName", "Acme Inc");
    type("cardNumber", "4111111111111111");
    type("expiryMonth", "12");
    type("expiryYear", "2030");
    type("cvv", "123");

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.CREDIT_CARD,
      title: "Corporate card",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      cardholderName: "Acme Inc",
      cardNumber: "4111 1111 1111 1111",
      brand: "Visa",
      expiryMonth: "12",
      expiryYear: "2030",
      cvv: "123",
    });
  });

  it("announces the detected brand and its length hint while typing", () => {
    render(<TeamCreditCardForm {...baseProps} />);
    expect(screen.getByText("cardNumberLengthHintGeneric")).toBeInTheDocument();

    type("cardNumber", "4111");

    expect(screen.getByText('cardNumberDetectedBrand:{"brand":"Visa"}')).toBeInTheDocument();
    expect(screen.getByText(/^cardNumberLengthHint:/)).toBeInTheDocument();
  });

  it("keeps a manually chosen brand when the number suggests another", async () => {
    render(<TeamCreditCardForm {...baseProps} />);
    setTitle("Card");
    type("brand", "Other");
    type("cardNumber", "4111111111111111");

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith(expect.objectContaining({ brand: "Other" }));
  });

  it("flags a number that fails the Luhn check and does not submit it", () => {
    render(<TeamCreditCardForm {...baseProps} />);
    setTitle("Card");
    type("cardNumber", "4111111111111112");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(screen.getByText("cardNumberInvalidLuhn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("flags a number of the wrong length", () => {
    render(<TeamCreditCardForm {...baseProps} />);
    type("cardNumber", "41111");
    expect(screen.getByText(/^cardNumberInvalidLength:/)).toBeInTheDocument();
  });

  it("does not submit without a title", () => {
    render(<TeamCreditCardForm {...baseProps} />);
    type("cardNumber", "4111111111111111");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("toggles card number and CVV visibility independently", () => {
    render(<TeamCreditCardForm {...baseProps} />);

    fireEvent.click(screen.getByText("toggle-card-number"));
    expect(screen.getByLabelText("cardNumber")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("cvv")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByText("toggle-cvv"));
    expect(screen.getByLabelText("cvv")).toHaveAttribute("type", "text");
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamCreditCardForm {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("in edit mode prefills every field, treats the stored brand as manual and shows attachments", async () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamCreditCardForm {...baseProps} editData={editData} />);

    expect(screen.getByLabelText("cardholderName")).toHaveValue("Acme Inc");
    expect(screen.getByLabelText("brand")).toHaveValue("Visa");
    expect(screen.getByLabelText("expiryMonth")).toHaveValue("12");
    expect(screen.getByLabelText("cvv")).toHaveValue("123");
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-4");

    type("cardNumber", "5555555555554444");
    fireEvent.click(screen.getByRole("button", { name: "update" }));

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith(expect.objectContaining({ brand: "Visa" }));
  });
});
