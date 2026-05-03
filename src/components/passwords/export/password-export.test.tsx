// @vitest-environment jsdom
/**
 * password-export — happy path + password-mismatch validation.
 *
 * Covers:
 *   - Renders the encrypted-warning when passwordProtect is true (default)
 *   - validatePassword: too-short error rendered, no fetch call
 *   - validatePassword: mismatch error rendered, no fetch call
 *   - happy path (passwordProtect=false): fetches passwords + folders, calls
 *     decryptData with built AAD, generates a download blob, audit-log POSTed
 *   - happy path: skipped entries (decrypt failure) increment skip count
 *   - §Sec-2: error path does NOT echo the user-entered export password
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const {
  mockDecryptData,
  mockBuildPersonalEntryAAD,
  mockEncryptExport,
  mockToastError,
  mockToastWarning,
  mockBuildFolderPath,
  mockFormatExportContentShared,
  mockFormatExportDate,
  mockFetchApi,
} = vi.hoisted(() => ({
  mockDecryptData: vi.fn(),
  mockBuildPersonalEntryAAD: vi.fn(),
  mockEncryptExport: vi.fn(),
  mockToastError: vi.fn(),
  mockToastWarning: vi.fn(),
  mockBuildFolderPath: vi.fn(),
  mockFormatExportContentShared: vi.fn(),
  mockFormatExportDate: vi.fn(() => "2026-05-04"),
  mockFetchApi: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    encryptionKey: { type: "key" } as unknown as CryptoKey,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildPersonalEntryAAD(...args),
}));

vi.mock("@/lib/crypto/export-crypto", () => ({
  encryptExport: (...args: unknown[]) => mockEncryptExport(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, warning: mockToastWarning },
}));

vi.mock("@/lib/folder/folder-path", () => ({
  buildFolderPath: (...args: unknown[]) => mockBuildFolderPath(...args),
}));

vi.mock("@/lib/format/export-format-common", () => ({
  formatExportContent: (...args: unknown[]) => mockFormatExportContentShared(...args),
  formatExportDate: () => mockFormatExportDate(),
  PERSONAL_EXPORT_OPTIONS: { kind: "personal" },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/components/layout/page-pane", () => ({
  PagePane: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => (
    <div>
      <div>{header}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock("@/components/layout/page-title-card", () => ({
  PageTitleCard: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

// Forward the export-options-panel props to a minimal interactive surface.
vi.mock("@/components/passwords/export/export-options-panel", () => ({
  ExportOptionsPanel: ({
    passwordProtect,
    onPasswordProtectChange,
    exportPassword,
    onExportPasswordChange,
    confirmPassword,
    onConfirmPasswordChange,
    passwordError,
    exporting,
    onExport,
  }: {
    passwordProtect: boolean;
    onPasswordProtectChange: (b: boolean) => void;
    exportPassword: string;
    onExportPasswordChange: (v: string) => void;
    confirmPassword: string;
    onConfirmPasswordChange: (v: string) => void;
    passwordError: string;
    exporting: boolean;
    onExport: (format: "csv" | "json") => void;
  }) => (
    <div>
      <label>
        protect
        <input
          type="checkbox"
          checked={passwordProtect}
          onChange={(e) => onPasswordProtectChange(e.target.checked)}
        />
      </label>
      <label>
        password
        <input
          aria-label="export-password"
          type="password"
          value={exportPassword}
          onChange={(e) => onExportPasswordChange(e.target.value)}
        />
      </label>
      <label>
        confirm
        <input
          aria-label="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
        />
      </label>
      {passwordError && <p data-testid="password-error">{passwordError}</p>}
      <button type="button" disabled={exporting} onClick={() => onExport("json")}>
        export-json
      </button>
    </div>
  ),
}));

import { ExportPagePanel } from "./password-export";

beforeEach(() => {
  vi.clearAllMocks();
  // Stub URL methods used in download-trigger code path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = vi.fn(() => "blob:mock");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = vi.fn();
  mockBuildPersonalEntryAAD.mockReturnValue("aad");
  mockBuildFolderPath.mockReturnValue("/Folder");
  mockFormatExportContentShared.mockReturnValue("CONTENT");
  mockEncryptExport.mockResolvedValue({ v: 1, ciphertext: "x" });
});

describe("ExportPagePanel — password validation guard", () => {
  it("renders the encrypted-warning by default", () => {
    render(<ExportPagePanel />);
    expect(screen.getByText("encryptedWarning")).toBeInTheDocument();
  });

  it("blocks export and shows passwordTooShort error when password is too short", async () => {
    render(<ExportPagePanel />);
    fireEvent.change(screen.getByLabelText("export-password"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("confirm-password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "export-json" }));

    await waitFor(() => {
      expect(screen.getByTestId("password-error")).toHaveTextContent("passwordTooShort");
    });
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("blocks export with passwordMismatch error when confirm differs", async () => {
    render(<ExportPagePanel />);
    fireEvent.change(screen.getByLabelText("export-password"), {
      target: { value: "longenoughpw" },
    });
    fireEvent.change(screen.getByLabelText("confirm-password"), {
      target: { value: "different-pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "export-json" }));

    await waitFor(() => {
      expect(screen.getByTestId("password-error")).toHaveTextContent("passwordMismatch");
    });
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("does NOT echo the user-entered export password into the error DOM (§Sec-2)", async () => {
    render(<ExportPagePanel />);
    fireEvent.change(screen.getByLabelText("export-password"), {
      target: { value: "SENTINEL_NOT_A_SECRET_ZJYK" },
    });
    fireEvent.change(screen.getByLabelText("confirm-password"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "export-json" }));

    await waitFor(() => {
      expect(screen.getByTestId("password-error")).toHaveTextContent("passwordMismatch");
    });
    // The password input field holds the value; assertion is on the error
    // surface only.
    const errorEl = screen.getByTestId("password-error");
    expect(errorEl.textContent).not.toContain("SENTINEL_NOT_A_SECRET_ZJYK");
  });
});

describe("ExportPagePanel — happy path", () => {
  it("decrypts entries, asserts AAD shape, formats the content, and POSTs an audit log (unencrypted JSON)", async () => {
    mockFetchApi.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("?include=blob")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: "entry-1",
                entryType: "LOGIN",
                encryptedBlob: { ciphertext: "c", iv: "i", authTag: "t" },
                aadVersion: 1,
                folderId: "folder-1",
              },
            ]),
        });
      }
      if (url.includes("/folders") && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: "folder-1", name: "Work", parentId: null }]),
        });
      }
      // Audit-log POST
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    mockDecryptData.mockResolvedValue(
      JSON.stringify({ title: "Site", username: "alice", password: "secret" }),
    );

    render(<ExportPagePanel />);
    // Disable password-protect to skip the validation gate
    fireEvent.click(screen.getByLabelText(/protect/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "export-json" }));
    });

    await waitFor(() => {
      expect(mockDecryptData).toHaveBeenCalledTimes(1);
    });

    // AAD shape: built with (userId, entryId)
    expect(mockBuildPersonalEntryAAD).toHaveBeenCalledWith("user-1", "entry-1");
    // The decryptData call's third arg should be the built AAD
    expect(mockDecryptData.mock.calls[0][2]).toBe("aad");

    // Content was formatted via the shared exporter
    expect(mockFormatExportContentShared).toHaveBeenCalled();

    // Audit-log POST happens (matched via the audit endpoint URL or method)
    await waitFor(() => {
      const auditCall = mockFetchApi.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(auditCall).toBeDefined();
      const body = JSON.parse((auditCall![1] as RequestInit).body as string);
      expect(body.entryCount).toBe(1);
      expect(body.format).toBe("json");
      expect(body.encrypted).toBe(false);
    });

    // No encryption was applied (passwordProtect is off)
    expect(mockEncryptExport).not.toHaveBeenCalled();
  });

  it("emits a warning toast when some entries fail to decrypt", async () => {
    mockFetchApi.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("?include=blob")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: "entry-ok",
                entryType: "LOGIN",
                encryptedBlob: { ciphertext: "c", iv: "i", authTag: "t" },
                aadVersion: 1,
              },
              {
                id: "entry-broken",
                entryType: "LOGIN",
                encryptedBlob: { ciphertext: "c", iv: "i", authTag: "t" },
                aadVersion: 1,
              },
            ]),
        });
      }
      if (url.includes("/folders") && !init?.method) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    mockDecryptData
      .mockResolvedValueOnce(JSON.stringify({ title: "OK" }))
      .mockRejectedValueOnce(new Error("decrypt failed"));

    render(<ExportPagePanel />);
    fireEvent.click(screen.getByLabelText(/protect/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "export-json" }));
    });

    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalled();
    });
  });

  it("emits an error toast when the entries fetch fails", async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes("?include=blob")) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    render(<ExportPagePanel />);
    fireEvent.click(screen.getByLabelText(/protect/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "export-json" }));
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("exportFailed");
    });
  });
});
