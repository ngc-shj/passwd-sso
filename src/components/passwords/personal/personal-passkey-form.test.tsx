// @vitest-environment jsdom
/**
 * PasskeyForm — passkey provider fields are preserved on round-trip submit.
 *
 * The opaque passkey provider fields (passkeyPrivateKeyJwk, passkeyUserHandle,
 * passkeySignCount, etc.) are never edited via the UI — they must be passed
 * through unchanged from initialData into the submitted fullBlob.
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

vi.mock("@/components/entry-fields/passkey-fields", () => ({
  PasskeyFields: ({
    relyingPartyId,
    onRelyingPartyIdChange,
  }: {
    relyingPartyId: string;
    onRelyingPartyIdChange: (v: string) => void;
  }) => (
    <input
      aria-label="rp-id"
      value={relyingPartyId}
      onChange={(e) => onRelyingPartyIdChange(e.target.value)}
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

import { PasskeyForm } from "./personal-passkey-form";

const baseInitial = {
  id: "pk-1",
  title: "GitHub passkey",
  relyingPartyId: "github.com",
  relyingPartyName: "GitHub",
  username: "alice",
  credentialId: "cred-id",
  creationDate: null,
  deviceInfo: null,
  notes: null,
  tags: [],
  passkeyPrivateKeyJwk: "OPAQUE_JWK",
  passkeyPublicKeyCose: "OPAQUE_COSE",
  passkeyUserHandle: "user-handle",
  passkeyUserDisplayName: "Alice",
  passkeySignCount: 7,
  passkeyAlgorithm: -7,
  passkeyTransports: ["internal"],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PasskeyForm", () => {
  it("renders the page-variant heading for create", () => {
    render(<PasskeyForm mode="create" variant="page" />);
    expect(screen.getByText("newPasskey")).toBeInTheDocument();
  });

  it("preserves all opaque passkey provider fields on edit-submit", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<PasskeyForm mode="edit" variant="dialog" initialData={baseInitial} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("PASSKEY");
    const fullBlob = JSON.parse(args.fullBlob);
    expect(fullBlob).toMatchObject({
      passkeyPrivateKeyJwk: "OPAQUE_JWK",
      passkeyPublicKeyCose: "OPAQUE_COSE",
      passkeyUserHandle: "user-handle",
      passkeyUserDisplayName: "Alice",
      passkeySignCount: 7,
      passkeyAlgorithm: -7,
      passkeyTransports: ["internal"],
    });
  });

  it("omits opaque provider fields when initialData is undefined (create mode)", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<PasskeyForm mode="create" variant="dialog" />);
    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "New Passkey" },
    });
    fireEvent.change(screen.getByLabelText("rp-id"), {
      target: { value: "example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });
    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const fullBlob = JSON.parse(mockSubmitEntry.mock.calls[0][0].fullBlob);
    expect(fullBlob).not.toHaveProperty("passkeyPrivateKeyJwk");
    expect(fullBlob.relyingPartyId).toBe("example.com");
  });
});
