// @vitest-environment jsdom
/**
 * SshKeyForm — auto-parse SSH key + submit blob.
 *
 * Covers:
 *   - successful parse populates publicKey/keyType/keySize/fingerprint and
 *     clears the format warning
 *   - failed parse renders the privateKeyFormatWarning
 *   - submit emits SSH_KEY entry type with parsed metadata in the blob
 *   - §Sec-2: parse failure does NOT echo the user-entered private key
 *     into the rendered DOM
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSubmitEntry, mockParseSshPrivateKey } = vi.hoisted(() => ({
  mockSubmitEntry: vi.fn(),
  mockParseSshPrivateKey: vi.fn(),
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

vi.mock("@/lib/format/ssh-key", () => ({
  parseSshPrivateKey: (...args: unknown[]) => mockParseSshPrivateKey(...args),
}));

vi.mock("@/components/entry-fields/ssh-key-fields", () => ({
  SshKeyFields: ({
    privateKey,
    onPrivateKeyChange,
    publicKey,
    keyType,
    fingerprint,
    privateKeyWarning,
  }: {
    privateKey: string;
    onPrivateKeyChange: (v: string) => Promise<void> | void;
    publicKey: string;
    keyType: string;
    fingerprint: string;
    privateKeyWarning: string;
  }) => (
    <>
      <textarea
        aria-label="private-key"
        value={privateKey}
        onChange={(e) => onPrivateKeyChange(e.target.value)}
      />
      <p data-testid="public-key">{publicKey}</p>
      <p data-testid="key-type">{keyType}</p>
      <p data-testid="fingerprint">{fingerprint}</p>
      {privateKeyWarning && <p data-testid="warning">{privateKeyWarning}</p>}
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

import { SshKeyForm } from "./personal-ssh-key-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SshKeyForm", () => {
  it("populates derived fields when the private key parses successfully", async () => {
    mockParseSshPrivateKey.mockResolvedValue({
      publicKey: "ssh-ed25519 AAA...",
      keyType: "ed25519",
      keySize: 256,
      fingerprint: "SHA256:abc",
      comment: "alice@host",
    });
    render(<SshKeyForm mode="create" variant="dialog" />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("private-key"), {
        target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\n..." },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("public-key")).toHaveTextContent("ssh-ed25519 AAA...");
    });
    expect(screen.getByTestId("key-type")).toHaveTextContent("ed25519");
    expect(screen.getByTestId("fingerprint")).toHaveTextContent("SHA256:abc");
    expect(screen.queryByTestId("warning")).toBeNull();
  });

  it("renders privateKeyFormatWarning when parse returns null", async () => {
    mockParseSshPrivateKey.mockResolvedValue(null);
    render(<SshKeyForm mode="create" variant="dialog" />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("private-key"), {
        target: { value: "garbage" },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("warning")).toHaveTextContent("privateKeyFormatWarning");
    });
  });

  it("does NOT echo the user-entered private key into the warning DOM (§Sec-2)", async () => {
    mockParseSshPrivateKey.mockResolvedValue(null);
    render(<SshKeyForm mode="create" variant="dialog" />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("private-key"), {
        target: { value: "SENTINEL_NOT_A_SECRET_ZJYK" },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("warning")).toBeInTheDocument();
    });
    expect(screen.getByTestId("warning").textContent).not.toContain("SENTINEL_NOT_A_SECRET_ZJYK");
  });

  it("submits with parsed metadata captured into the SSH_KEY blob", async () => {
    mockParseSshPrivateKey.mockResolvedValue({
      publicKey: "ssh-ed25519 PUB",
      keyType: "ed25519",
      keySize: 256,
      fingerprint: "SHA256:fp",
      comment: "alice@host",
    });
    mockSubmitEntry.mockResolvedValue(undefined);
    render(<SshKeyForm mode="create" variant="dialog" />);

    fireEvent.change(screen.getByRole("textbox", { name: "title" }), {
      target: { value: "Prod key" },
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("private-key"), {
        target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\n..." },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("public-key")).toHaveTextContent("ssh-ed25519 PUB");
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit"));
    });

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalled());
    const args = mockSubmitEntry.mock.calls[0][0];
    expect(args.entryType).toBe("SSH_KEY");
    const fullBlob = JSON.parse(args.fullBlob);
    expect(fullBlob).toMatchObject({
      title: "Prod key",
      keyType: "ed25519",
      keySize: 256,
      fingerprint: "SHA256:fp",
      publicKey: "ssh-ed25519 PUB",
    });
  });
});
