// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { mockSubmitEntry, mockHandleOpenChange, baseConfig } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
  mockHandleOpenChange: vi.fn(),
  baseConfig: { isEdit: false, initialTitle: "", requireRepromptForAll: false },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    defaultValue,
    onValueChange,
  }: {
    children: React.ReactNode;
    defaultValue?: string;
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label="template"
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
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

vi.mock("@/components/entry-fields/secure-note-fields", () => ({
  SecureNoteFields: ({
    content,
    onContentChange,
  }: {
    content: string;
    onContentChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="content"
      value={content}
      onChange={(e) => onContentChange(e.target.value)}
    />
  ),
}));

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

import { TeamSecureNoteForm } from "./team-secure-note-form";
import { ENTRY_TYPE } from "@/lib/constants";
import { SECURE_NOTE_TEMPLATES } from "@/lib/format/secure-note-templates";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.SECURE_NOTE,
};

const editData: TeamEntryFormEditData = {
  id: "entry-9",
  title: "Router",
  username: null,
  password: "",
  url: null,
  notes: null,
  content: "existing note",
};

function titleInput() {
  return screen.getByPlaceholderText("title-ph");
}

function contentInput() {
  return screen.getByLabelText("content");
}

function templateContent(id: string): string {
  const tmpl = SECURE_NOTE_TEMPLATES.find((tp) => tp.id === id);
  if (!tmpl) throw new Error(`template ${id} missing`);
  return tmpl.contentTemplate;
}

describe("TeamSecureNoteForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseConfig.isEdit = false;
    baseConfig.initialTitle = "";
    baseConfig.requireRepromptForAll = false;
    mockSubmitEntry.mockResolvedValue(undefined);
  });

  it("fills title and content from the chosen template", () => {
    render(<TeamSecureNoteForm {...baseProps} />);

    fireEvent.change(screen.getByLabelText("template"), { target: { value: "wifi" } });

    expect(titleInput()).toHaveValue("template_wifi");
    expect(contentInput()).toHaveValue(templateContent("wifi"));
  });

  it("clears title and content when switching back to the blank template", () => {
    render(<TeamSecureNoteForm {...baseProps} />);
    const select = screen.getByLabelText("template");
    fireEvent.change(select, { target: { value: "wifi" } });

    fireEvent.change(select, { target: { value: "blank" } });

    expect(titleInput()).toHaveValue("");
    expect(contentInput()).toHaveValue("");
  });

  it("submits a secure-note payload with the typed title, content and tag names", async () => {
    render(<TeamSecureNoteForm {...baseProps} />);
    fireEvent.change(titleInput(), { target: { value: "Router" } });
    fireEvent.change(contentInput(), { target: { value: "admin / hunter2" } });

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.SECURE_NOTE,
      title: "Router",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      content: "admin / hunter2",
    });
  });

  it("does not submit when the title is only whitespace", () => {
    const { container } = render(<TeamSecureNoteForm {...baseProps} />);
    fireEvent.change(titleInput(), { target: { value: "   " } });

    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    const form = container.querySelector("form");
    if (!form) throw new Error("form not rendered");
    fireEvent.submit(form);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamSecureNoteForm {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the policy-forced reprompt label when the team requires reprompt for all", () => {
    baseConfig.requireRepromptForAll = true;
    render(<TeamSecureNoteForm {...baseProps} />);

    expect(screen.getByText("requireRepromptPolicyForced")).toBeInTheDocument();
  });

  it("in edit mode prefills content, hides the template picker and shows attachments", () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamSecureNoteForm {...baseProps} editData={editData} />);

    expect(contentInput()).toHaveValue("existing note");
    expect(screen.queryByLabelText("template")).toBeNull();
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-9");
    expect(screen.getByRole("button", { name: "update" })).toBeInTheDocument();
  });
});
