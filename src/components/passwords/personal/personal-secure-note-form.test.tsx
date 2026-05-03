// @vitest-environment jsdom
/**
 * SecureNoteForm — render + submit blob shape.
 *
 * Covers:
 *   - dialog variant renders without the back button
 *   - page variant renders the back button
 *   - selecting a non-blank template populates the title and content
 *   - submitting builds the expected fullBlob/overviewBlob shape
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSubmitEntry, mockHandleBack, mockHandleCancel } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
  mockHandleBack: vi.fn(),
  mockHandleCancel: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/personal/use-personal-base-form-model", () => ({
  usePersonalBaseFormModel: (args: {
    variant?: "page" | "dialog";
    initialTitle?: string | null;
  }) => {
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
      handleCancel: mockHandleCancel,
      handleBack: mockHandleBack,
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

vi.mock("@/lib/format/secure-note-templates", () => ({
  SECURE_NOTE_TEMPLATES: [
    { id: "blank", titleKey: "templateBlank", contentTemplate: "" },
    { id: "wifi", titleKey: "templateWifi", contentTemplate: "SSID: \nPSK: " },
  ],
}));

vi.mock("@/components/entry-fields/secure-note-fields", () => ({
  SecureNoteFields: ({
    content,
    onContentChange,
    contentLabel,
  }: {
    content: string;
    onContentChange: (v: string) => void;
    contentLabel: string;
  }) => (
    <label>
      {contentLabel}
      <textarea
        aria-label={contentLabel}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
      />
    </label>
  ),
}));

vi.mock("@/components/passwords/entry/entry-form-ui", () => ({
  EntryActionBar: () => (
    <button type="submit" data-testid="submit">
      submit
    </button>
  ),
  EntryPrimaryCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  EntrySectionCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick}>
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

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    defaultValue,
  }: {
    children: React.ReactNode;
    onValueChange: (v: string) => void;
    defaultValue?: string;
  }) => (
    <select
      data-testid="template-select"
      defaultValue={defaultValue}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

import { SecureNoteForm } from "./personal-secure-note-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SecureNoteForm", () => {
  it("renders the page variant with a back button", () => {
    render(<SecureNoteForm mode="create" variant="page" />);
    expect(screen.getByRole("button", { name: /back/ })).toBeInTheDocument();
    expect(screen.getByText("newNote")).toBeInTheDocument();
  });

  it("renders the dialog variant without the back button", () => {
    render(<SecureNoteForm mode="create" variant="dialog" />);
    expect(screen.queryByText("newNote")).toBeNull();
  });

  it("populates title and content when a non-blank template is selected", () => {
    render(<SecureNoteForm mode="create" variant="dialog" />);
    const select = screen.getByTestId("template-select");
    fireEvent.change(select, { target: { value: "wifi" } });

    expect(
      (screen.getByRole("textbox", { name: "title" }) as HTMLInputElement).value,
    ).toBe("templateWifi");
    expect((screen.getByLabelText("content") as HTMLTextAreaElement).value).toBe(
      "SSID: \nPSK: ",
    );
  });

  it("submits with the SECURE_NOTE entry type and a markdown blob", async () => {
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<SecureNoteForm mode="create" variant="dialog" />);

    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "My Note" },
    });
    fireEvent.change(screen.getByLabelText("content"), {
      target: { value: "secret content" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });

    await waitFor(() => {
      expect(mockSubmitEntry).toHaveBeenCalledTimes(1);
    });
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("SECURE_NOTE");
    const fullBlob = JSON.parse(args.fullBlob);
    expect(fullBlob).toMatchObject({
      title: "My Note",
      content: "secret content",
      isMarkdown: true,
    });
    const overview = JSON.parse(args.overviewBlob);
    expect(overview.title).toBe("My Note");
    expect(overview.snippet).toBe("secret content");
  });
});
