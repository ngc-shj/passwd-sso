// @vitest-environment jsdom
/**
 * IdentityForm — render variants + submit blob.
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

vi.mock("@/lib/format/format-datetime", () => ({
  toISODateString: (v: string) => v,
}));

vi.mock("@/components/entry-fields/identity-fields", () => ({
  IdentityFields: ({
    fullName,
    onFullNameChange,
    idNumber,
    onIdNumberChange,
    givenName,
    onGivenNameChange,
    familyName,
    onFamilyNameChange,
    postalCode,
    onPostalCodeChange,
    city,
    onCityChange,
  }: {
    fullName: string;
    onFullNameChange: (v: string) => void;
    idNumber: string;
    onIdNumberChange: (v: string) => void;
    givenName: string;
    onGivenNameChange: (v: string) => void;
    familyName: string;
    onFamilyNameChange: (v: string) => void;
    postalCode: string;
    onPostalCodeChange: (v: string) => void;
    city: string;
    onCityChange: (v: string) => void;
  }) => (
    <>
      <input
        aria-label="full-name"
        value={fullName}
        onChange={(e) => onFullNameChange(e.target.value)}
      />
      <input
        aria-label="id-number"
        value={idNumber}
        onChange={(e) => onIdNumberChange(e.target.value)}
      />
      <input
        aria-label="given-name"
        value={givenName}
        onChange={(e) => onGivenNameChange(e.target.value)}
      />
      <input
        aria-label="family-name"
        value={familyName}
        onChange={(e) => onFamilyNameChange(e.target.value)}
      />
      <input
        aria-label="postal-code"
        value={postalCode}
        onChange={(e) => onPostalCodeChange(e.target.value)}
      />
      <input
        aria-label="city"
        value={city}
        onChange={(e) => onCityChange(e.target.value)}
      />
    </>
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

import { IdentityForm } from "./personal-identity-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IdentityForm", () => {
  it("renders the page-variant heading", () => {
    render(<IdentityForm mode="create" variant="page" />);
    expect(screen.getByText("newIdentity")).toBeInTheDocument();
  });

  it("submits with the IDENTITY entry type and the entered fields", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<IdentityForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Driver License" },
    });
    fireEvent.change(screen.getByLabelText("full-name"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByLabelText("id-number"), {
      target: { value: "ID-123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("IDENTITY");
    const fullBlob = JSON.parse(args.fullBlob);
    expect(fullBlob).toMatchObject({
      title: "Driver License",
      fullName: "Alice",
      idNumber: "ID-123",
    });
  });

  it("persists structured fields (givenName, familyName, postalCode, city) in fullBlob", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<IdentityForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Passport" },
    });
    fireEvent.change(screen.getByLabelText("given-name"), {
      target: { value: "Taro" },
    });
    fireEvent.change(screen.getByLabelText("family-name"), {
      target: { value: "Yamada" },
    });
    fireEvent.change(screen.getByLabelText("postal-code"), {
      target: { value: "160-0022" },
    });
    fireEvent.change(screen.getByLabelText("city"), {
      target: { value: "Shinjuku" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    const fullBlob = JSON.parse(args.fullBlob);
    expect(fullBlob).toMatchObject({
      title: "Passport",
      givenName: "Taro",
      familyName: "Yamada",
      postalCode: "160-0022",
      city: "Shinjuku",
    });
  });

  it("overview composes fullName from givenName+familyName when fullName is empty", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<IdentityForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "ID Card" },
    });
    // fullName intentionally left blank
    fireEvent.change(screen.getByLabelText("given-name"), {
      target: { value: "Hanako" },
    });
    fireEvent.change(screen.getByLabelText("family-name"), {
      target: { value: "Suzuki" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    const overviewBlob = JSON.parse(args.overviewBlob);
    // composeIdentityNameLabel builds "Hanako Suzuki" when fullName is empty
    expect(overviewBlob.fullName).toBe("Hanako Suzuki");
  });
});
