// @vitest-environment jsdom
/**
 * CreditCardForm — submit gate on Luhn/length, brand auto-detection.
 *
 * Covers:
 *   - submit blocked when card number is invalid (length error)
 *   - submit succeeds with valid card number; overview includes lastFour
 *   - manually setting brand prevents auto-detect from overriding it
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSubmitEntry } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/personal/use-personal-base-form-model", () => ({
  usePersonalBaseFormModel: (args: { variant?: "page" | "dialog"; initialTitle?: string | null }) => {
    const [title, setTitle] = React.useState(args.initialTitle ?? "");
    return {
      folders: [],
      submitting: false,
      title,
      setTitle,
      selectedTags: [],
      setSelectedTags: vi.fn(),
      folderId: null,
      setFolderId: vi.fn(),
      requireReprompt: false,
      setRequireReprompt: vi.fn(),
      expiresAt: null,
      setExpiresAt: vi.fn(),
      handleCancel: vi.fn(),
      handleBack: vi.fn(),
      submitEntry: mockSubmitEntry,
      isDialogVariant: args.variant === "dialog",
    };
  },
}));

vi.mock("@/hooks/personal/personal-form-sections-props", () => ({
  buildPersonalFormSectionsProps: () => ({
    tagsAndFolderProps: {},
    repromptSectionProps: {},
    travelSafeSectionProps: {},
    expirationSectionProps: {},
    actionBarProps: {},
  }),
}));

vi.mock("@/hooks/form/use-before-unload-guard", () => ({
  useBeforeUnloadGuard: vi.fn(),
}));

vi.mock("@/hooks/form/use-entry-has-changes", () => ({
  useEntryHasChanges: () => true,
}));

vi.mock("@/components/passwords/entry/entry-form-tags", () => ({
  toTagPayload: () => [],
}));

vi.mock("@/components/entry-fields/credit-card-fields", () => ({
  CreditCardFields: ({
    cardNumber,
    onCardNumberChange,
    brand,
    onBrandChange,
    showLengthError,
  }: {
    cardNumber: string;
    onCardNumberChange: (v: string) => void;
    brand: string;
    onBrandChange: (v: string) => void;
    showLengthError: boolean;
  }) => (
    <>
      <input
        aria-label="card-number"
        value={cardNumber}
        onChange={(e) => onCardNumberChange(e.target.value)}
      />
      <input
        aria-label="brand"
        value={brand}
        onChange={(e) => onBrandChange(e.target.value)}
      />
      {showLengthError && <p data-testid="length-error">length-error</p>}
    </>
  ),
}));

vi.mock("@/components/passwords/entry/entry-form-ui", () => ({
  EntryActionBar: ({ submitDisabled }: { submitDisabled?: boolean }) => (
    <button type="submit" data-testid="submit" disabled={submitDisabled}>
      submit
    </button>
  ),
  EntryPrimaryCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS: "",
  ENTRY_DIALOG_FLAT_SECTION_CLASS: "",
}));

vi.mock("@/components/passwords/entry/entry-tags-and-folder-section", () => ({
  EntryTagsAndFolderSection: () => null,
}));
vi.mock("@/components/passwords/entry/entry-reprompt-section", () => ({
  EntryRepromptSection: () => null,
}));
vi.mock("@/components/passwords/entry/entry-travel-safe-section", () => ({
  EntryTravelSafeSection: () => null,
}));
vi.mock("@/components/passwords/entry/entry-expiration-section", () => ({
  EntryExpirationSection: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, type, onClick }: React.ComponentProps<"button">) => (
    <button type={type} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => (
    <label {...rest}>{children}</label>
  ),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { CreditCardForm } from "./personal-credit-card-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreditCardForm", () => {
  it("disables submit when card number is too short (length error visible)", async () => {
    render(<CreditCardForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Card" },
    });
    fireEvent.change(screen.getByLabelText("card-number"), {
      target: { value: "123" },
    });

    expect(screen.getByTestId("length-error")).toBeInTheDocument();
    expect(screen.getByTestId("submit")).toBeDisabled();
  });

  it("submits with overview lastFour for a valid 16-digit card", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<CreditCardForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Card" },
    });
    // A Visa test number that satisfies Luhn
    fireEvent.change(screen.getByLabelText("card-number"), {
      target: { value: "4111111111111111" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("CREDIT_CARD");
    const overview = JSON.parse(args.overviewBlob);
    expect(overview.lastFour).toBe("1111");
  });

  it("respects manual brand selection over auto-detected brand", () => {
    render(<CreditCardForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByLabelText("brand"), {
      target: { value: "JCB" },
    });
    fireEvent.change(screen.getByLabelText("card-number"), {
      target: { value: "4111" },
    });
    // Brand input value remains JCB (manual) — auto-detect won't override.
    expect((screen.getByLabelText("brand") as HTMLInputElement).value).toBe("JCB");
  });
});
