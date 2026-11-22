// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { mockSubmitEntry, mockHandleOpenChange, mockParse, baseConfig } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
  mockParse: vi.fn(),
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

vi.mock("@/lib/format/ssh-key", () => ({
  parseSshPrivateKey: mockParse,
}));

vi.mock("@/components/entry-fields/ssh-key-fields", () => {
  type FieldProps = {
    privateKey: string;
    onPrivateKeyChange: (v: string) => void;
    showPrivateKey: boolean;
    onTogglePrivateKey: () => void;
    publicKey: string;
    onPublicKeyChange: (v: string) => void;
    keyType: string;
    fingerprint: string;
    keySize: number;
    passphrase: string;
    onPassphraseChange: (v: string) => void;
    showPassphrase: boolean;
    onTogglePassphrase: () => void;
    comment: string;
    onCommentChange: (v: string) => void;
    privateKeyWarning: string;
  };
  return {
    SshKeyFields: (p: FieldProps) => (
      <div>
        <textarea
          aria-label="privateKey"
          data-shown={String(p.showPrivateKey)}
          value={p.privateKey}
          onChange={(e) => p.onPrivateKeyChange(e.target.value)}
        />
        <button type="button" onClick={p.onTogglePrivateKey}>toggle-private-key</button>
        <input aria-label="publicKey" value={p.publicKey} onChange={(e) => p.onPublicKeyChange(e.target.value)} />
        <input
          aria-label="passphrase"
          type={p.showPassphrase ? "text" : "password"}
          value={p.passphrase}
          onChange={(e) => p.onPassphraseChange(e.target.value)}
        />
        <button type="button" onClick={p.onTogglePassphrase}>toggle-passphrase</button>
        <input aria-label="comment" value={p.comment} onChange={(e) => p.onCommentChange(e.target.value)} />
        <output aria-label="keyType">{p.keyType}</output>
        <output aria-label="keySize">{p.keySize}</output>
        <output aria-label="fingerprint">{p.fingerprint}</output>
        {p.privateKeyWarning && <p>{p.privateKeyWarning}</p>}
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

import { TeamSshKeyForm } from "./team-ssh-key-form";
import { ENTRY_TYPE } from "@/lib/constants";
import type { ParsedSshKey } from "@/lib/format/ssh-key";
import type { TeamEntryFormEditData } from "./team-entry-form-types";

const baseProps = {
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
  entryType: ENTRY_TYPE.SSH_KEY,
};

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

const PARSED: ParsedSshKey = {
  keyType: "ed25519",
  publicKey: "ssh-ed25519 AAAA user@host",
  fingerprint: "SHA256:xyz",
  keySize: 256,
  comment: "user@host",
};

function typePrivateKey(value: string) {
  fireEvent.change(screen.getByLabelText("privateKey"), { target: { value } });
}

describe("TeamSshKeyForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseConfig.isEdit = false;
    baseConfig.initialTitle = "";
    baseConfig.requireRepromptForAll = false;
    mockSubmitEntry.mockResolvedValue(undefined);
    mockParse.mockResolvedValue(PARSED);
  });

  it("fills the derived key fields from a parsed private key", async () => {
    render(<TeamSshKeyForm {...baseProps} />);

    typePrivateKey(PEM);

    await waitFor(() => expect(screen.getByLabelText("publicKey")).toHaveValue(PARSED.publicKey));
    expect(mockParse).toHaveBeenCalledWith(PEM);
    expect(screen.getByLabelText("keyType")).toHaveTextContent("ed25519");
    expect(screen.getByLabelText("keySize")).toHaveTextContent("256");
    expect(screen.getByLabelText("fingerprint")).toHaveTextContent("SHA256:xyz");
    expect(screen.getByLabelText("comment")).toHaveValue("user@host");
  });

  it("keeps a typed comment when the parsed key carries none", async () => {
    mockParse.mockResolvedValue({ ...PARSED, comment: "" });
    render(<TeamSshKeyForm {...baseProps} />);
    fireEvent.change(screen.getByLabelText("comment"), { target: { value: "my laptop" } });

    typePrivateKey(PEM);

    await waitFor(() => expect(screen.getByLabelText("publicKey")).toHaveValue(PARSED.publicKey));
    expect(screen.getByLabelText("comment")).toHaveValue("my laptop");
  });

  it("warns when the private key cannot be parsed", async () => {
    mockParse.mockResolvedValue(null);
    render(<TeamSshKeyForm {...baseProps} />);

    typePrivateKey("garbage");

    expect(await screen.findByText("privateKeyFormatWarning")).toBeInTheDocument();
  });

  it("warns when parsing the private key throws", async () => {
    mockParse.mockRejectedValue(new Error("bad key"));
    render(<TeamSshKeyForm {...baseProps} />);

    typePrivateKey("garbage");

    expect(await screen.findByText("privateKeyFormatWarning")).toBeInTheDocument();
  });

  it("clears the derived fields and warning when the private key is emptied", async () => {
    render(<TeamSshKeyForm {...baseProps} />);
    typePrivateKey(PEM);
    await waitFor(() => expect(screen.getByLabelText("publicKey")).toHaveValue(PARSED.publicKey));
    mockParse.mockClear();

    typePrivateKey("   ");

    expect(screen.getByLabelText("publicKey")).toHaveValue("");
    expect(screen.getByLabelText("keyType")).toHaveTextContent("");
    expect(screen.getByLabelText("keySize")).toHaveTextContent("0");
    expect(screen.getByLabelText("fingerprint")).toHaveTextContent("");
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("clears an earlier parse warning when the private key is emptied", async () => {
    mockParse.mockResolvedValue(null);
    render(<TeamSshKeyForm {...baseProps} />);
    typePrivateKey("garbage");
    await screen.findByText("privateKeyFormatWarning");

    typePrivateKey("");

    expect(screen.queryByText("privateKeyFormatWarning")).toBeNull();
  });

  it("parses the stored private key on mount in edit mode", async () => {
    baseConfig.isEdit = true;
    baseConfig.initialTitle = "server";
    const editData: TeamEntryFormEditData = {
      id: "entry-3",
      title: "server",
      username: null,
      password: "",
      url: null,
      notes: null,
      privateKey: PEM,
    };
    render(<TeamSshKeyForm {...baseProps} editData={editData} />);

    await waitFor(() => expect(screen.getByLabelText("fingerprint")).toHaveTextContent("SHA256:xyz"));
    expect(mockParse).toHaveBeenCalledWith(PEM);
    expect(screen.getByTestId("attachments")).toHaveTextContent("entry-3");
  });

  it("submits the parsed key material together with the passphrase", async () => {
    render(<TeamSshKeyForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "server" } });
    typePrivateKey(PEM);
    await waitFor(() => expect(screen.getByLabelText("publicKey")).toHaveValue(PARSED.publicKey));
    fireEvent.change(screen.getByLabelText("passphrase"), { target: { value: "pp" } });

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.SSH_KEY,
      title: "server",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      privateKey: PEM,
      publicKey: PARSED.publicKey,
      keyType: "ed25519",
      keySize: 256,
      fingerprint: "SHA256:xyz",
      passphrase: "pp",
      sshComment: "user@host",
    });
  });

  it("sends empty key fields as undefined rather than empty strings", async () => {
    render(<TeamSshKeyForm {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("title-ph"), { target: { value: "server" } });

    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledTimes(1));
    expect(mockSubmitEntry).toHaveBeenCalledWith({
      entryType: ENTRY_TYPE.SSH_KEY,
      title: "server",
      notes: "",
      tagNames: [{ name: "work", color: "#f00" }],
      privateKey: undefined,
      publicKey: undefined,
      keyType: undefined,
      keySize: undefined,
      fingerprint: undefined,
      passphrase: undefined,
      sshComment: undefined,
    });
  });

  it("toggles private key and passphrase visibility independently", () => {
    render(<TeamSshKeyForm {...baseProps} />);

    fireEvent.click(screen.getByText("toggle-private-key"));
    expect(screen.getByLabelText("privateKey")).toHaveAttribute("data-shown", "true");
    expect(screen.getByLabelText("passphrase")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByText("toggle-passphrase"));
    expect(screen.getByLabelText("passphrase")).toHaveAttribute("type", "text");
  });

  it("closes through the base model when cancel is clicked", () => {
    render(<TeamSshKeyForm {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(mockHandleOpenChange).toHaveBeenCalledWith(false);
  });
});
