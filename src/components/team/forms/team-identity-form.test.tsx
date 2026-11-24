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

import { TeamIdentityForm } from "./team-identity-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.IDENTITY,
};

const editData: TeamEntryFormEditData = {
  id: "entry-9",
  title: "Passport",
  username: null,
  password: "",
  url: null,
  notes: null,
  familyName: "Yamada",
  givenName: "Taro",
  idNumber: "TK1234567",
  issueDate: "2020-01-01",
  expiryDate: "2030-01-01",
};

const fieldValues = {
  familyName: "Yamada",
  givenName: "Taro",
  middleName: "Q",
  familyNameKana: "ヤマダ",
  givenNameKana: "タロウ",
  fullName: "Taro Yamada",
  addressLine1: "1-2-3 Chiyoda",
  addressLine2: "Room 4",
  city: "Chiyoda-ku",
  state: "Tokyo",
  postalCode: "100-0001",
  country: "Japan",
  address: "1-2-3 Chiyoda, Tokyo",
  phone: "+81-3-0000-0000",
  email: "taro@example.com",
  dateOfBirth: "1990-01-02",
  nationality: "JP",
  idNumber: "TK1234567",
  issueDate: "2020-01-01",
  expiryDate: "2030-01-01",
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

describe("TeamIdentityForm", () => {
  beforeEach(resetBase);

  it("submits an identity payload with every entered field", async () => {
    render(<TeamIdentityForm {...baseProps} />);
    setTitle("Passport");
    for (const [label, value] of Object.entries(fieldValues)) type(label, value);

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.IDENTITY,
      title: "Passport",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      ...fieldValues,
    });
  });

  it("rejects a date of birth in the future and does not submit", () => {
    render(<TeamIdentityForm {...baseProps} />);
    setTitle("Passport");
    type("dateOfBirth", "2999-01-01");

    save();

    expect(screen.getByText("dobFuture")).toBeInTheDocument();
    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("clears the date-of-birth error once the date is edited", () => {
    render(<TeamIdentityForm {...baseProps} />);
    setTitle("Passport");
    type("dateOfBirth", "2999-01-01");
    save();

    type("dateOfBirth", "1990-01-02");

    expect(screen.queryByText("dobFuture")).not.toBeInTheDocument();
  });

  it("rejects an expiry date that is not after the issue date", () => {
    render(<TeamIdentityForm {...baseProps} />);
    setTitle("Passport");
    type("issueDate", "2025-05-01");
    type("expiryDate", "2025-05-01");

    save();

    expect(screen.getByText("expiryBeforeIssue")).toBeInTheDocument();
    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it.each(["issueDate", "expiryDate"])("clears the expiry error when %s is edited", (label) => {
    render(<TeamIdentityForm {...baseProps} />);
    setTitle("Passport");
    type("issueDate", "2025-05-01");
    type("expiryDate", "2025-04-01");
    save();
    expect(screen.getByText("expiryBeforeIssue")).toBeInTheDocument();

    type(label, label === "issueDate" ? "2024-01-01" : "2030-01-01");

    expect(screen.queryByText("expiryBeforeIssue")).not.toBeInTheDocument();
  });

  it("does not submit without a title", () => {
    render(<TeamIdentityForm {...baseProps} />);
    type("fullName", "Taro Yamada");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("toggles ID number visibility", () => {
    render(<TeamIdentityForm {...baseProps} />);
    const idNumber = screen.getByLabelText("idNumber");
    expect(idNumber).toHaveAttribute("type", "password");

    fireEvent.click(idNumber.nextElementSibling as HTMLElement);

    expect(idNumber).toHaveAttribute("type", "text");
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamIdentityForm {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("in edit mode prefills the fields and shows attachments", () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamIdentityForm {...baseProps} editData={editData} />);

    expect(screen.getByLabelText("familyName")).toHaveValue("Yamada");
    expect(screen.getByLabelText("givenName")).toHaveValue("Taro");
    expect(screen.getByLabelText("idNumber")).toHaveValue("TK1234567");
    expect(screen.getByLabelText("expiryDate")).toHaveValue("2030-01-01");
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-9");
  });
});
