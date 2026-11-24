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

vi.mock("@/components/entry-fields/software-license-fields", () => {
  type FieldProps = {
    softwareName: string;
    onSoftwareNameChange: (v: string) => void;
    licenseKey: string;
    onLicenseKeyChange: (v: string) => void;
    showLicenseKey: boolean;
    onToggleLicenseKey: () => void;
    version: string;
    onVersionChange: (v: string) => void;
    licensee: string;
    onLicenseeChange: (v: string) => void;
    purchaseDate: string;
    onPurchaseDateChange: (v: string) => void;
    expirationDate: string;
    onExpirationDateChange: (v: string) => void;
    expiryError: string | null;
  };
  return {
    SoftwareLicenseFields: (p: FieldProps) => (
      <div>
        <input aria-label="softwareName" value={p.softwareName} onChange={(e) => p.onSoftwareNameChange(e.target.value)} />
        <input
          aria-label="licenseKey"
          type={p.showLicenseKey ? "text" : "password"}
          value={p.licenseKey}
          onChange={(e) => p.onLicenseKeyChange(e.target.value)}
        />
        <button type="button" onClick={p.onToggleLicenseKey}>toggle-license-key</button>
        <input aria-label="version" value={p.version} onChange={(e) => p.onVersionChange(e.target.value)} />
        <input aria-label="licensee" value={p.licensee} onChange={(e) => p.onLicenseeChange(e.target.value)} />
        <input aria-label="purchaseDate" value={p.purchaseDate} onChange={(e) => p.onPurchaseDateChange(e.target.value)} />
        <input aria-label="expirationDate" value={p.expirationDate} onChange={(e) => p.onExpirationDateChange(e.target.value)} />
        {p.expiryError && <p>{p.expiryError}</p>}
      </div>
    ),
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

import { TeamSoftwareLicenseForm } from "./team-software-license-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
};

const editData: TeamEntryFormEditData = {
  id: "entry-7",
  title: "IDE",
  username: null,
  password: "",
  url: null,
  notes: null,
  softwareName: "JetBrains",
  licenseKey: "KEY-123",
  version: "2026.1",
  licensee: "Acme",
  email: "it@example.com",
  purchaseDate: "2026-01-01",
  expirationDate: "2027-01-01",
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "save" }));
}

describe("TeamSoftwareLicenseForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseConfig.isEdit = false;
    baseConfig.initialTitle = "";
    baseConfig.requireRepromptForAll = false;
    mockSubmitEntry.mockResolvedValue(undefined);
  });

  it("submits a software-license payload with every entered field", async () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "IDE" } });
    type("softwareName", "JetBrains");
    type("licenseKey", "KEY-123");
    type("version", "2026.1");
    type("licensee", "Acme");
    type("email", "it@example.com");
    type("purchaseDate", "2026-01-01");
    type("expirationDate", "2027-01-01");

    save();

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
      title: "IDE",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      softwareName: "JetBrains",
      licenseKey: "KEY-123",
      version: "2026.1",
      licensee: "Acme",
      email: "it@example.com",
      purchaseDate: "2026-01-01",
      expirationDate: "2027-01-01",
    });
  });

  // "user@localhost" passes the browser's type=email check but not the form's
  // stricter domain-with-dot rule, so it reaches the component's own guard.
  it("rejects an email without a dotted domain with an error and does not submit", () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "IDE" } });
    type("email", "user@localhost");

    save();

    expect(screen.getByText("invalidEmail")).toBeInTheDocument();
    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it("clears the email error once the email is edited", () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "IDE" } });
    type("email", "user@localhost");
    save();

    type("email", "it@example.com");

    expect(screen.queryByText("invalidEmail")).toBeNull();
  });

  it("rejects an expiration date that is not after the purchase date", () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "IDE" } });
    type("purchaseDate", "2026-05-01");
    type("expirationDate", "2026-05-01");

    save();

    expect(screen.getByText("expirationBeforePurchase")).toBeInTheDocument();
    expect(mockSubmitEntry).not.toHaveBeenCalled();
  });

  it.each(["purchaseDate", "expirationDate"])(
    "clears the expiry error when %s is edited",
    (label) => {
      render(<TeamSoftwareLicenseForm {...baseProps} />);
      fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "IDE" } });
      type("purchaseDate", "2026-05-01");
      type("expirationDate", "2026-04-01");
      save();
      expect(screen.getByText("expirationBeforePurchase")).toBeInTheDocument();

      type(label, label === "purchaseDate" ? "2026-01-01" : "2027-01-01");

      expect(screen.queryByText("expirationBeforePurchase")).toBeNull();
    },
  );

  it("toggles license key visibility", () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);
    expect(screen.getByLabelText("licenseKey")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByText("toggle-license-key"));

    expect(screen.getByLabelText("licenseKey")).toHaveAttribute("type", "text");
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamSoftwareLicenseForm {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });

  it("in edit mode prefills every field and shows attachments", () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = editData.title;
    render(<TeamSoftwareLicenseForm {...baseProps} editData={editData} />);

    expect(screen.getByLabelText("softwareName")).toHaveValue("JetBrains");
    expect(screen.getByLabelText("licenseKey")).toHaveValue("KEY-123");
    expect(screen.getByLabelText("version")).toHaveValue("2026.1");
    expect(screen.getByLabelText("licensee")).toHaveValue("Acme");
    expect(screen.getByLabelText("email")).toHaveValue("it@example.com");
    expect(screen.getByLabelText("purchaseDate")).toHaveValue("2026-01-01");
    expect(screen.getByLabelText("expirationDate")).toHaveValue("2027-01-01");
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-7");
  });
});
