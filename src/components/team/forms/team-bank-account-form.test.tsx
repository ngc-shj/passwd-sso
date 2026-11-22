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

import { TeamBankAccountForm } from "./team-bank-account-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.BANK_ACCOUNT,
};

const editData: TeamEntryFormEditData = {
  id: "entry-3",
  title: "Payroll",
  username: null,
  password: "",
  url: null,
  notes: null,
  bankName: "Acme Bank",
  accountType: "savings",
  accountHolderName: "Acme Inc",
  accountNumber: "0123456789",
  routingNumber: "021000021",
  swiftBic: "ACMEUS33",
  iban: "US00ACME0123",
  branchName: "Main",
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

describe("TeamBankAccountForm", () => {
  beforeEach(resetBase);

  it("submits a bank-account payload with every entered field", async () => {
    render(<TeamBankAccountForm {...baseProps} />);
    setTitle("Payroll");
    type("bankName", "Acme Bank");
    type("accountHolderName", "Acme Inc");
    type("accountNumber", "0123456789");
    type("routingNumber", "021000021");
    type("swiftBic", "ACMEUS33");
    type("iban", "US00ACME0123");
    type("branchName", "Main");
    fireEvent.change(screen.getByPlaceholderText("notes-ph"), { target: { value: "memo" } });

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.BANK_ACCOUNT,
      title: "Payroll",
      notes: "memo",
      tagNames: [{ name: "work", color: "#f00" }],
      bankName: "Acme Bank",
      accountType: "",
      accountHolderName: "Acme Inc",
      accountNumber: "0123456789",
      routingNumber: "021000021",
      swiftBic: "ACMEUS33",
      iban: "US00ACME0123",
      branchName: "Main",
    });
  });

  it("does not submit without a title", () => {
    render(<TeamBankAccountForm {...baseProps} />);
    type("bankName", "Acme Bank");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("does not submit a whitespace-only title", () => {
    render(<TeamBankAccountForm {...baseProps} />);
    setTitle("   ");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("toggles the account number and routing number visibility independently", () => {
    render(<TeamBankAccountForm {...baseProps} />);
    const account = screen.getByLabelText("accountNumber");
    const routing = screen.getByLabelText("routingNumber");
    expect(account).toHaveAttribute("type", "password");
    expect(routing).toHaveAttribute("type", "password");

    fireEvent.click(account.nextElementSibling as HTMLElement);
    expect(account).toHaveAttribute("type", "text");
    expect(routing).toHaveAttribute("type", "password");

    fireEvent.click(routing.nextElementSibling as HTMLElement);
    expect(routing).toHaveAttribute("type", "text");
  });

  it("shows the policy-forced reprompt label when the team requires reprompt", () => {
    baseConfig.requireRepromptForAll = true;
    render(<TeamBankAccountForm {...baseProps} />);
    expect(screen.getByText("requireRepromptPolicyForced")).toBeInTheDocument();
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamBankAccountForm {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not show attachments when creating", () => {
    render(<TeamBankAccountForm {...baseProps} />);
    expect(screen.queryByTestId("attachments")).not.toBeInTheDocument();
  });

  it("in edit mode prefills every field, submits them unchanged and shows attachments", async () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamBankAccountForm {...baseProps} editData={editData} />);

    expect(screen.getByLabelText("bankName")).toHaveValue("Acme Bank");
    expect(screen.getByLabelText("iban")).toHaveValue("US00ACME0123");
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-3");

    fireEvent.submit(screen.getByPlaceholderText("title-ph").closest("form") as HTMLFormElement);

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Payroll",
        accountType: "savings",
        accountHolderName: "Acme Inc",
        accountNumber: "0123456789",
        routingNumber: "021000021",
        swiftBic: "ACMEUS33",
        branchName: "Main",
      }),
    );
  });
});
