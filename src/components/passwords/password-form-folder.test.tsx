// @vitest-environment jsdom
/**
 * PasswordForm — Folder selector integration tests
 *
 * Covers:
 *   - Folder select renders when folders exist (fetched from API)
 *   - Folder select hidden when no folders exist
 *   - initialData.folderId pre-selects the correct folder
 *   - Selecting a folder includes folderId in the API body
 *   - Selecting "(None)" sends folderId: null
 *   - Hierarchy indentation in folder options
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────

const { mockEncryptData, mockRouter, mockEncryptionKey } = vi.hoisted(() => ({
  mockEncryptData: vi.fn().mockResolvedValue({
    ciphertext: "encrypted",
    iv: "iv",
    authTag: "tag",
  }),
  mockRouter: { push: vi.fn(), back: vi.fn(), refresh: vi.fn() },
  mockEncryptionKey: new Uint8Array(32),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => mockRouter,
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    encryptionKey: mockEncryptionKey,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/crypto-client", () => ({
  encryptData: mockEncryptData,
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildPersonalEntryAAD: () => new Uint8Array(16),
  AAD_VERSION: 1,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub heavy sub-components
vi.mock("./password-generator", () => ({
  PasswordGenerator: () => null,
}));

vi.mock("./totp-field", () => ({
  TOTPField: () => null,
}));

vi.mock("@/components/tags/tag-input", () => ({
  TagInput: () => <div data-testid="tag-input" />,
}));

vi.mock("@/components/passwords/entry-form-ui", () => ({
  EntryActionBar: ({
    onCancel,
    saveLabel,
    hasChanges,
    submitting,
  }: {
    onCancel: () => void;
    saveLabel: string;
    hasChanges: boolean;
    submitting: boolean;
    cancelLabel: string;
    statusUnsavedLabel: string;
    statusSavedLabel: string;
  }) => (
    <div>
      <button type="submit" disabled={submitting || !hasChanges}>
        {saveLabel}
      </button>
      <button type="button" onClick={onCancel}>
        cancel
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

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CardTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    asChild,
    ...rest
  }: React.ComponentProps<"button"> & { asChild?: boolean }) => {
    if (asChild) return <>{children}</>;
    return (
      <button onClick={onClick} disabled={disabled} {...rest}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    ...rest
  }: React.ComponentProps<"label">) => <label {...rest}>{children}</label>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: () => <input type="checkbox" />,
}));

// Select mock — native select for testability
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select
      data-testid="folder-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectValue: () => null,
}));

import { PasswordForm } from "./password-form";

// ── Helpers ──────────────────────────────────────────────────

const FOLDERS = [
  { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 2 },
  { id: "f2", name: "Projects", parentId: "f1", sortOrder: 0, entryCount: 1 },
  { id: "f3", name: "Personal", parentId: null, sortOrder: 1, entryCount: 0 },
];

function mockFetch(folders: unknown[] = FOLDERS) {
  return vi.fn((url: string, init?: RequestInit) => {
    // GET /api/folders — return folder list
    if (url.includes("/api/folders") && !init?.method) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(folders),
      });
    }
    // POST/PUT for submit — capture the body
    if (init?.method === "POST" || init?.method === "PUT") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "new-id" }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }) as Mock;
}

const baseInitialData = {
  id: "entry-1",
  title: "Test Entry",
  username: "user",
  password: "pass123",
  url: "https://example.com",
  notes: "",
  tags: [],
};

describe("PasswordForm folder selector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders folder select when folders are fetched", async () => {
    globalThis.fetch = mockFetch();

    await act(async () => {
      render(
        <PasswordForm mode="create" variant="dialog" />,
      );
    });

    // Wait for folders to load
    await waitFor(() => {
      const selects = screen.getAllByTestId("folder-select");
      // The folder select should be present (may have custom field type selects too)
      const folderSelect = selects.find((s) => {
        const options = s.querySelectorAll("option");
        return Array.from(options).some((o) => o.value === "__none__");
      });
      expect(folderSelect).toBeDefined();
    });
  });

  it("does not render folder select when no folders exist", async () => {
    globalThis.fetch = mockFetch([]);

    await act(async () => {
      render(
        <PasswordForm mode="create" variant="dialog" />,
      );
    });

    // Give time for fetch to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // All selects should be custom field type selects only (no __none__ option)
    const selects = screen.queryAllByTestId("folder-select");
    const folderSelect = selects.find((s) => {
      const options = s.querySelectorAll("option");
      return Array.from(options).some((o) => o.value === "__none__");
    });
    expect(folderSelect).toBeUndefined();
  });

  it("pre-selects folder from initialData.folderId", async () => {
    globalThis.fetch = mockFetch();

    await act(async () => {
      render(
        <PasswordForm
          mode="edit"
          variant="dialog"
          initialData={{ ...baseInitialData, folderId: "f1" }}
        />,
      );
    });

    await waitFor(() => {
      const selects = screen.getAllByTestId("folder-select");
      const folderSelect = selects.find((s) => {
        const options = s.querySelectorAll("option");
        return Array.from(options).some((o) => o.value === "__none__");
      });
      expect(folderSelect).toBeDefined();
      expect((folderSelect as HTMLSelectElement).value).toBe("f1");
    });
  });

  it("includes folderId in submit body when folder is selected", async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(
        <PasswordForm
          mode="create"
          variant="dialog"
          onSaved={vi.fn()}
        />,
      );
    });

    // Wait for folders to load
    await waitFor(() => {
      const selects = screen.getAllByTestId("folder-select");
      expect(
        selects.some((s) =>
          Array.from(s.querySelectorAll("option")).some(
            (o) => o.value === "__none__",
          ),
        ),
      ).toBe(true);
    });

    // Fill required fields
    const titleInput = screen.getByPlaceholderText("titlePlaceholder");
    fireEvent.change(titleInput, { target: { value: "My Entry" } });

    const passwordInput = screen.getByPlaceholderText("passwordPlaceholder");
    fireEvent.change(passwordInput, { target: { value: "secret123" } });

    // Select folder "Work"
    const folderSelect = screen
      .getAllByTestId("folder-select")
      .find((s) =>
        Array.from(s.querySelectorAll("option")).some(
          (o) => o.value === "__none__",
        ),
      )!;
    fireEvent.change(folderSelect, { target: { value: "f1" } });

    // Submit
    const form = screen.getByText("save").closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.folderId).toBe("f1");
    });
  });

  it("sends folderId null when (None) is selected", async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(
        <PasswordForm
          mode="edit"
          variant="dialog"
          initialData={{ ...baseInitialData, folderId: "f1" }}
          onSaved={vi.fn()}
        />,
      );
    });

    // Wait for folders
    await waitFor(() => {
      const selects = screen.getAllByTestId("folder-select");
      expect(
        selects.some((s) =>
          Array.from(s.querySelectorAll("option")).some(
            (o) => o.value === "__none__",
          ),
        ),
      ).toBe(true);
    });

    // Change folder to "(None)"
    const folderSelect = screen
      .getAllByTestId("folder-select")
      .find((s) =>
        Array.from(s.querySelectorAll("option")).some(
          (o) => o.value === "__none__",
        ),
      )!;
    fireEvent.change(folderSelect, { target: { value: "__none__" } });

    // Submit
    const form = screen.getByText("update").closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.folderId).toBeNull();
    });
  });

  it("shows hierarchy indentation for nested folders", async () => {
    globalThis.fetch = mockFetch();

    await act(async () => {
      render(
        <PasswordForm mode="create" variant="dialog" />,
      );
    });

    await waitFor(() => {
      const selects = screen.getAllByTestId("folder-select");
      const folderSelect = selects.find((s) =>
        Array.from(s.querySelectorAll("option")).some(
          (o) => o.value === "__none__",
        ),
      );
      expect(folderSelect).toBeDefined();

      const options = folderSelect!.querySelectorAll("option");
      const optionTexts = Array.from(options).map((o) => ({
        value: o.value,
        text: o.textContent,
      }));

      // "Work" (root) should not have indent
      const work = optionTexts.find((o) => o.value === "f1");
      expect(work?.text).toBe("Work");

      // "Projects" (child of Work) should have indent with └
      const projects = optionTexts.find((o) => o.value === "f2");
      expect(projects?.text).toContain("└");
      expect(projects?.text).toContain("Projects");
    });
  });

  // ── IME guard ──────────────────────────────────────────────

  it("does not submit when Enter is pressed during IME composition", async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(
        <PasswordForm mode="create" variant="dialog" onSaved={vi.fn()} />,
      );
    });

    // Fill required fields
    const titleInput = screen.getByPlaceholderText("titlePlaceholder");
    fireEvent.change(titleInput, { target: { value: "テスト" } });

    const passwordInput = screen.getByPlaceholderText("passwordPlaceholder");
    fireEvent.change(passwordInput, { target: { value: "pass123" } });

    // Simulate Enter during IME composition on the form
    const form = screen.getByText("save").closest("form")!;
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    form.dispatchEvent(composingEnter);

    // Give time for any async handlers
    await new Promise((r) => setTimeout(r, 50));

    // No POST should have been made (only the initial GET for folders)
    const postCalls = fetchMock.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });
});
