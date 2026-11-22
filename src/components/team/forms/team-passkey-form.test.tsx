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

import { TeamPasskeyForm } from "./team-passkey-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.PASSKEY,
};

const editData: TeamEntryFormEditData = {
  id: "entry-5",
  title: "GitHub passkey",
  username: "octo",
  password: "",
  url: null,
  notes: null,
  relyingPartyId: "github.com",
  relyingPartyName: "GitHub",
  credentialId: "cred-abc",
  creationDate: "2025-03-04",
  deviceInfo: "YubiKey",
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

describe("TeamPasskeyForm", () => {
  beforeEach(resetBase);

  it("submits a passkey payload with every entered field", async () => {
    render(<TeamPasskeyForm {...baseProps} />);
    setTitle("GitHub passkey");
    type("relyingPartyId", "github.com");
    type("relyingPartyName", "GitHub");
    type("username", "octo");
    type("credentialId", "cred-abc");
    type("creationDate", "2025-03-04");
    type("deviceInfo", "YubiKey");

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.PASSKEY,
      title: "GitHub passkey",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      relyingPartyId: "github.com",
      relyingPartyName: "GitHub",
      username: "octo",
      credentialId: "cred-abc",
      creationDate: "2025-03-04",
      deviceInfo: "YubiKey",
    });
  });

  it("keeps save disabled and does not submit until a relying party ID is entered", async () => {
    render(<TeamPasskeyForm {...baseProps} />);
    setTitle("GitHub passkey");
    type("relyingPartyId", "   ");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);
    expect(mockSubmitEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

    type("relyingPartyId", "github.com");
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("does not submit without a title", () => {
    render(<TeamPasskeyForm {...baseProps} />);
    type("relyingPartyId", "github.com");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("toggles credential ID visibility", () => {
    render(<TeamPasskeyForm {...baseProps} />);
    const credential = screen.getByLabelText("credentialId");
    expect(credential).toHaveAttribute("type", "password");

    fireEvent.click(credential.nextElementSibling as HTMLElement);

    expect(credential).toHaveAttribute("type", "text");
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamPasskeyForm {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("in edit mode prefills every field and shows attachments", () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamPasskeyForm {...baseProps} editData={editData} />);

    expect(screen.getByLabelText("relyingPartyId")).toHaveValue("github.com");
    expect(screen.getByLabelText("relyingPartyName")).toHaveValue("GitHub");
    expect(screen.getByLabelText("username")).toHaveValue("octo");
    expect(screen.getByLabelText("credentialId")).toHaveValue("cred-abc");
    expect(screen.getByLabelText("creationDate")).toHaveValue("2025-03-04");
    expect(screen.getByLabelText("deviceInfo")).toHaveValue("YubiKey");
    expect(screen.getByRole("button", { name: "update" })).toBeInTheDocument();
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-5");
  });
});
