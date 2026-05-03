// @vitest-environment jsdom
/**
 * BankAccountForm — render variants + submit blob shape.
 *
 * Covers:
 *   - dialog vs page variant render
 *   - account-number last4 derivation in the overview blob
 *   - account-number with fewer than 4 digits → null in overview
 *   - submitEntry receives BANK_ACCOUNT entry type
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

vi.mock("@/components/entry-fields/bank-account-fields", () => ({
  BankAccountFields: ({
    accountNumber,
    onAccountNumberChange,
  }: {
    accountNumber: string;
    onAccountNumberChange: (v: string) => void;
  }) => (
    <input
      aria-label="account-number"
      value={accountNumber}
      onChange={(e) => onAccountNumberChange(e.target.value)}
    />
  ),
}));

vi.mock("@/components/passwords/entry/entry-form-ui", () => ({
  EntryActionBar: () => (
    <button type="submit" data-testid="submit">
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

import { BankAccountForm } from "./personal-bank-account-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BankAccountForm", () => {
  it("renders the page-variant heading", () => {
    render(<BankAccountForm mode="create" variant="page" />);
    expect(screen.getByText("newBankAccount")).toBeInTheDocument();
  });

  it("submits with last-4 derived from a long account number in the overview blob", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<BankAccountForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Bank A" },
    });
    fireEvent.change(screen.getByLabelText("account-number"), {
      target: { value: "1234-5678-9012" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("BANK_ACCOUNT");
    const overview = JSON.parse(args.overviewBlob);
    expect(overview.accountNumberLast4).toBe("9012");
  });

  it("renders accountNumberLast4 = null when fewer than 4 digits are entered", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<BankAccountForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Bank B" },
    });
    fireEvent.change(screen.getByLabelText("account-number"), {
      target: { value: "12" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const overview = JSON.parse(mockSubmitEntry.mock.calls[0][0].overviewBlob);
    expect(overview.accountNumberLast4).toBeNull();
  });
});
