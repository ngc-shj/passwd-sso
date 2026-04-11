// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Radix Checkbox (used by EntryRepromptSection) requires ResizeObserver
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("@/lib/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamKeyInfo: vi.fn().mockResolvedValue({ key: {} as CryptoKey, keyVersion: 1 }),
    getTeamEncryptionKey: vi.fn(),
    getEntryDecryptionKey: vi.fn().mockResolvedValue({} as CryptoKey),
    invalidateTeamKey: vi.fn(),
    clearAll: vi.fn(),
    distributePendingKeys: vi.fn(),
  }),
}));

vi.mock("@/lib/crypto-team", () => ({
  generateItemKey: () => new Uint8Array(32),
  wrapItemKey: async () => ({ ciphertext: "ik-ct", iv: "ik-iv", authTag: "ik-at" }),
  deriveItemEncryptionKey: async () => ({} as CryptoKey),
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildItemKeyWrapAAD: vi.fn().mockReturnValue("ik-aad"),
  buildTeamEntryAAD: vi.fn().mockReturnValue("team-aad"),
}));

// Mock save entry helper to skip encryption (this is a UI test, not a crypto test)
vi.mock("@/lib/team-entry-save", () => ({
  saveTeamEntry: vi.fn(async (params: Record<string, unknown>) => {
    const teamId = params.teamId as string;
    const entryId = params.entryId as string | undefined;
    const mode = params.mode as string;
    const endpoint = mode === "create"
      ? `/api/teams/${teamId}/passwords`
      : `/api/teams/${teamId}/passwords/${entryId}`;
    return fetch(endpoint, {
      method: mode === "create" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamFolderId: params.teamFolderId ?? null,
        tagIds: params.tagIds,
        entryType: params.entryType,
      }),
    });
  }),
}));

vi.mock("@/lib/generator-prefs", () => ({
  DEFAULT_GENERATOR_SETTINGS: {
    mode: "password",
    length: 16,
    passphrase: { wordCount: 4 },
  },
  DEFAULT_SYMBOL_GROUPS: {
    hashEtc: false,
    punctuation: false,
    quotes: false,
    slashDash: false,
    mathCompare: false,
    brackets: false,
  },
  SYMBOL_GROUP_KEYS: ["hashEtc", "punctuation", "quotes", "slashDash", "mathCompare", "brackets"],
}));

vi.mock("@/lib/credit-card", () => ({
  CARD_BRANDS: ["Visa", "Mastercard"],
  detectCardBrand: vi.fn().mockReturnValue(""),
  formatCardNumber: vi.fn((_v: string) => _v),
  getAllowedLengths: vi.fn().mockReturnValue(null),
  getCardNumberValidation: vi.fn().mockReturnValue({
    digits: "",
    effectiveBrand: "",
    detectedBrand: "",
    lengthValid: true,
    luhnValid: true,
  }),
  getMaxLength: vi.fn().mockReturnValue(19),
  normalizeCardBrand: vi.fn((b: string) => b),
  normalizeCardNumber: vi.fn((v: string) => v.replace(/\D/g, "")),
}));

vi.mock("@/hooks/use-team-policy", () => ({
  useTeamPolicy: () => ({
    policy: {
      minPasswordLength: 0,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
      passwordHistoryCount: 0,
      inheritTenantCidrs: true,
      teamAllowedCidrs: [],
    },
  }),
}));

// Minimal UI component mocks
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} type={type} {...rest}>
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

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));

// Select mock — tracks value and fires onValueChange
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <div data-testid="select" data-value={value}>
      <select
        value={value}
        onChange={(e) => onValueChange?.(e.target.value)}
        data-testid="select-native"
      >
        {children}
      </select>
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

vi.mock("@/components/passwords/password-generator", () => ({
  PasswordGenerator: () => null,
}));

vi.mock("@/components/passwords/totp-field", () => ({
  TOTPField: () => null,
}));

vi.mock("@/components/team/team-tag-input", () => ({
  TeamTagInput: () => <div data-testid="team-tag-input" />,
}));

vi.mock("@/components/team/team-attachment-section", () => ({
  TeamAttachmentSection: () => null,
}));

vi.mock("@/components/passwords/entry-form-ui", () => ({
  ENTRY_DIALOG_FLAT_SECTION_CLASS:
    "!rounded-none !border-0 !bg-transparent !px-1 !py-2 !shadow-none hover:!bg-transparent",
  ENTRY_DIALOG_FLAT_PRIMARY_CARD_CLASS:
    "!rounded-none !border-0 !bg-transparent !from-transparent !to-transparent !p-0 !shadow-none",
  EntryActionBar: ({
    onCancel,
    submitDisabled,
  }: {
    onCancel: () => void;
    submitDisabled: boolean;
    hasChanges: boolean;
    submitting: boolean;
    saveLabel: string;
    cancelLabel: string;
    statusUnsavedLabel: string;
    statusSavedLabel: string;
  }) => (
    <div>
      <button type="submit" disabled={submitDisabled} data-testid="submit-btn">
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
  EntryPrimaryCard: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  EntrySectionCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="section-card">{children}</div>
  ),
}));

import { TeamLoginForm } from "./team-login-form";

/* ---------- helpers ---------- */

const FOLDERS = [
  { id: "folder-1", name: "Work", parentId: null, sortOrder: 0, entryCount: 3 },
  { id: "folder-2", name: "Personal", parentId: null, sortOrder: 1, entryCount: 1 },
];

function setupFetch(folders = FOLDERS, submitOk = true) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    // Folder list
    if (url.includes("/folders")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(folders),
      });
    }
    // Attachment list
    if (url.includes("/attachments")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    // Password create/update
    if (url.includes("/passwords") && init?.method) {
      return Promise.resolve({
        ok: submitOk,
        json: () => Promise.resolve({ id: "new-entry" }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

/* ---------- tests ---------- */

describe("TeamLoginForm — folder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("fetches team folders when dialog opens", async () => {
    setupFetch();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((u: string) => u.includes("/teams/team-1/folders"))).toBe(true);
    });
  });

  it("renders folder selector when folders exist", async () => {
    setupFetch();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    await waitFor(() => {
      // The folder section label should appear
      expect(screen.getByText("folder")).toBeInTheDocument();
    });
  });

  it("shows 'no folders yet' message instead of select when no folders", async () => {
    setupFetch([]);

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    // Wait for folder fetch to settle
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some((u: string) => u.includes("/folders"))).toBe(true);
    });

    // Folder section label should be visible
    const folderLabels = screen.queryAllByText("folder");
    expect(folderLabels.length).toBe(1);
    // "No folders yet" message should appear
    expect(screen.getByText("noFoldersYet")).toBeDefined();
  });

  it("initializes teamFolderId from editData", async () => {
    setupFetch();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
          editData={{
            id: "entry-1",
            title: "Test",
            username: "user",
            password: "pass",
            url: null,
            notes: null,
            teamFolderId: "folder-1",
          }}
        />,
      );
    });

    await waitFor(() => {
      // Find the select for folders — its data-value should be folder-1
      const selects = screen.getAllByTestId("select");
      const folderSelect = selects.find(
        (el) => el.getAttribute("data-value") === "folder-1",
      );
      expect(folderSelect).toBeInTheDocument();
    });
  });

  it("sends teamFolderId in submit payload", async () => {
    setupFetch();
    const onSaved = vi.fn();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={onSaved}
          editData={{
            id: "entry-1",
            title: "Test",
            username: "user",
            password: "pass",
            url: null,
            notes: null,
            teamFolderId: "folder-2",
          }}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("folder")).toBeInTheDocument();
    });

    // Submit the form
    const submitBtn = screen.getByTestId("submit-btn");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as Record<string, unknown>).body as string);
      expect(body.teamFolderId).toBe("folder-2");
    });
  });

  it("sends null teamFolderId when folder is deselected", async () => {
    setupFetch();
    const onSaved = vi.fn();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={onSaved}
          editData={{
            id: "entry-1",
            title: "Test",
            username: "user",
            password: "pass",
            url: null,
            notes: null,
            teamFolderId: null,
          }}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("folder")).toBeInTheDocument();
    });

    // Submit — teamFolderId should be null
    const submitBtn = screen.getByTestId("submit-btn");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as Record<string, unknown>).body as string);
      expect(body.teamFolderId).toBeNull();
    });
  });

  it("re-applies latest editData after close and reopen (conditional rendering)", async () => {
    setupFetch();
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();

    // Simulate production pattern: parent conditionally renders TeamLoginForm
    function Wrapper({ formOpen, editData }: { formOpen: boolean; editData: React.ComponentProps<typeof TeamLoginForm>["editData"] }) {
      return formOpen ? (
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          editData={editData}
        />
      ) : null;
    }

    const view = render(
      <Wrapper
        formOpen={true}
        editData={{
          id: "entry-1",
          title: "First Title",
          username: "first-user",
          password: "first-pass",
          url: null,
          notes: null,
          teamFolderId: "folder-1",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("First Title")).toBeInTheDocument();
    });

    // Close: unmount
    view.rerender(
      <Wrapper
        formOpen={false}
        editData={null}
      />,
    );

    // Re-open with different editData: remount → useState picks up new initial values
    view.rerender(
      <Wrapper
        formOpen={true}
        editData={{
          id: "entry-2",
          title: "Second Title",
          username: "second-user",
          password: "second-pass",
          url: null,
          notes: null,
          teamFolderId: "folder-2",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("Second Title")).toBeInTheDocument();
      const selects = screen.getAllByTestId("select");
      const folderSelect = selects.find(
        (el) => el.getAttribute("data-value") === "folder-2",
      );
      expect(folderSelect).toBeInTheDocument();
    });
  });

  it("uses the translated login field keys for labels", async () => {
    setupFetch();

    await act(async () => {
      render(
        <TeamLoginForm
          teamId="team-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    expect(screen.getByText("usernameEmail")).toBeInTheDocument();
    expect(screen.getByText("password")).toBeInTheDocument();
    expect(screen.getByText("url")).toBeInTheDocument();
    expect(screen.queryByText("usernameLabel")).not.toBeInTheDocument();
    expect(screen.queryByText("passwordLabel")).not.toBeInTheDocument();
    expect(screen.queryByText("urlLabel")).not.toBeInTheDocument();
  });
});
