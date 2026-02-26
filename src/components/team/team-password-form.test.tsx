// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
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
    invalidateOrgKey: vi.fn(),
    clearAll: vi.fn(),
    distributePendingKeys: vi.fn(),
  }),
}));

// Mock saveOrgEntry to skip encryption (this is a UI test, not a crypto test)
vi.mock("@/lib/org-entry-save", () => ({
  saveOrgEntry: vi.fn(async (params: Record<string, unknown>) => {
    const orgId = params.orgId as string;
    const initialId = params.initialId as string | undefined;
    const mode = params.mode as string;
    const endpoint = mode === "create"
      ? `/api/teams/${orgId}/passwords`
      : `/api/teams/${orgId}/passwords/${initialId}`;
    return fetch(endpoint, {
      method: mode === "create" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgFolderId: params.orgFolderId,
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
  TeamTagInput: () => <div data-testid="org-tag-input" />,
  OrgTagInput: () => <div data-testid="org-tag-input" />,
}));

vi.mock("@/components/team/team-attachment-section", () => ({
  OrgAttachmentSection: () => null,
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

import { OrgPasswordForm } from "./team-password-form";

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

describe("OrgPasswordForm — folder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("fetches org folders when dialog opens", async () => {
    setupFetch();

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
      expect(calls.some((u: string) => u.includes("/teams/org-1/folders"))).toBe(true);
    });
  });

  it("renders folder selector when folders exist", async () => {
    setupFetch();

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
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

  it("does NOT render folder selector when no folders", async () => {
    setupFetch([]);

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
          open={true}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });

    // Wait for folder fetch to settle
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map((c: [string]) => c[0]);
      expect(calls.some((u: string) => u.includes("/folders"))).toBe(true);
    });

    // The folder section label should NOT appear (beyond tags/custom fields)
    // "folder" as a label text should not be in the document
    const folderLabels = screen.queryAllByText("folder");
    // When no folders exist, the folder EntrySectionCard should not render
    // Check that the folder label from the folder section is absent
    expect(folderLabels.length).toBe(0);
  });

  it("initializes orgFolderId from editData", async () => {
    setupFetch();

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
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
            orgFolderId: "folder-1",
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

  it("sends orgFolderId in submit payload", async () => {
    setupFetch();
    const onSaved = vi.fn();

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
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
            orgFolderId: "folder-2",
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
        (c: [string, RequestInit?]) => c[1]?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.orgFolderId).toBe("folder-2");
    });
  });

  it("sends null orgFolderId when folder is deselected", async () => {
    setupFetch();
    const onSaved = vi.fn();

    await act(async () => {
      render(
        <OrgPasswordForm
          orgId="org-1"
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
            orgFolderId: null,
          }}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("folder")).toBeInTheDocument();
    });

    // Submit — orgFolderId should be null
    const submitBtn = screen.getByTestId("submit-btn");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.orgFolderId).toBeNull();
    });
  });

  it("re-applies latest editData after close and reopen", async () => {
    setupFetch();
    const onOpenChange = vi.fn();

    const view = render(
      <OrgPasswordForm
        orgId="org-1"
        open={true}
        onOpenChange={onOpenChange}
        onSaved={vi.fn()}
        editData={{
          id: "entry-1",
          title: "First Title",
          username: "first-user",
          password: "first-pass",
          url: null,
          notes: null,
          orgFolderId: "folder-1",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("First Title")).toBeInTheDocument();
    });

    view.rerender(
      <OrgPasswordForm
        orgId="org-1"
        open={false}
        onOpenChange={onOpenChange}
        onSaved={vi.fn()}
        editData={{
          id: "entry-1",
          title: "First Title",
          username: "first-user",
          password: "first-pass",
          url: null,
          notes: null,
          orgFolderId: "folder-1",
        }}
      />,
    );

    view.rerender(
      <OrgPasswordForm
        orgId="org-1"
        open={true}
        onOpenChange={onOpenChange}
        onSaved={vi.fn()}
        editData={{
          id: "entry-2",
          title: "Second Title",
          username: "second-user",
          password: "second-pass",
          url: null,
          notes: null,
          orgFolderId: "folder-2",
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
});
