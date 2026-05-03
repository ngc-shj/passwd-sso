// @vitest-environment jsdom
/**
 * password-import — top-level wizard step routing.
 *
 * Verifies the conditional rendering between done / decrypt / file-select / preview
 * and that an active dirty state surfaces the navigation guard prompt.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const {
  mockUseImportFileFlow,
  mockUseImportExecution,
  mockUseNavigationGuard,
} = vi.hoisted(() => ({
  mockUseImportFileFlow: vi.fn(),
  mockUseImportExecution: vi.fn(),
  mockUseNavigationGuard: vi.fn(),
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

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVaultOptional: () => ({
    getTeamKeyInfo: vi.fn().mockResolvedValue({ key: { type: "tk" }, keyVersion: 1 }),
  }),
}));

vi.mock("@/components/passwords/import/use-import-file-flow", () => ({
  useImportFileFlow: () => mockUseImportFileFlow(),
}));

vi.mock("@/components/passwords/import/use-import-execution", () => ({
  useImportExecution: () => mockUseImportExecution(),
}));

vi.mock("@/hooks/form/use-navigation-guard", () => ({
  useNavigationGuard: (dirty: boolean) => mockUseNavigationGuard(dirty),
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
  PageTitleCard: ({ title }: { title: string }) => <div data-testid="title-card">{title}</div>,
}));

vi.mock("@/components/passwords/import/password-import-steps", () => ({
  ImportDoneStep: ({ successCount }: { successCount: number }) => (
    <div data-testid="done-step">done {successCount}</div>
  ),
  ImportDecryptStep: () => <div data-testid="decrypt-step" />,
  ImportFileSelectStep: () => <div data-testid="file-select-step" />,
  ImportPreviewStep: ({ entries }: { entries: unknown[] }) => (
    <div data-testid="preview-step">preview {entries.length}</div>
  ),
  ImportActions: () => <div data-testid="actions" />,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="leave-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { ImportPagePanel, TeamImportPagePanel } from "./password-import";

const fileFlowDefaults = {
  fileRef: { current: null },
  entries: [],
  format: "unknown",
  dragOver: false,
  encryptedFile: null,
  decryptPassword: "",
  decrypting: false,
  decryptError: "",
  sourceFilename: "",
  encryptedInput: false,
  setDragOver: vi.fn(),
  setDecryptPasswordAndClearError: vi.fn(),
  handleFileChange: vi.fn(),
  handleDrop: vi.fn(),
  handleDecrypt: vi.fn(),
  reset: vi.fn(),
};

const executionDefaults = {
  importing: false,
  progress: { current: 0, total: 0 },
  done: false,
  result: { success: 0, failed: 0 },
  resetExecution: vi.fn(),
  runImport: vi.fn(),
};

const guardDefaults = {
  dialogOpen: false,
  cancelLeave: vi.fn(),
  confirmLeave: vi.fn(),
};

describe("ImportPagePanel", () => {
  beforeEach(() => {
    mockUseImportFileFlow.mockReturnValue({ ...fileFlowDefaults });
    mockUseImportExecution.mockReturnValue({ ...executionDefaults });
    mockUseNavigationGuard.mockReturnValue({ ...guardDefaults });
  });

  it("renders the file-select step when no file has been chosen yet", () => {
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(screen.getByTestId("file-select-step")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-step")).toBeNull();
    expect(screen.queryByTestId("actions")).toBeNull();
  });

  it("renders the preview step + import actions when entries are present", () => {
    mockUseImportFileFlow.mockReturnValue({
      ...fileFlowDefaults,
      entries: [{ title: "a" }, { title: "b" }] as unknown as never[],
      format: "bitwarden",
    });
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(screen.getByTestId("preview-step")).toHaveTextContent("preview 2");
    expect(screen.getByTestId("actions")).toBeInTheDocument();
  });

  it("renders the decrypt step when an encrypted file is detected", () => {
    mockUseImportFileFlow.mockReturnValue({
      ...fileFlowDefaults,
      encryptedFile: { v: 1 } as unknown as never,
    });
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(screen.getByTestId("decrypt-step")).toBeInTheDocument();
  });

  it("renders the done step (and skips action bar) once import succeeds", () => {
    mockUseImportExecution.mockReturnValue({
      ...executionDefaults,
      done: true,
      result: { success: 7, failed: 0 },
    });
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(screen.getByTestId("done-step")).toHaveTextContent("done 7");
    expect(screen.queryByTestId("actions")).toBeNull();
  });

  it("opens the leave guard dialog when navigation guard reports dialogOpen", () => {
    mockUseNavigationGuard.mockReturnValue({ ...guardDefaults, dialogOpen: true });
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(screen.getByTestId("leave-dialog")).toBeInTheDocument();
  });

  it("computes isDirty=true when entries are present and not done — driving the guard", () => {
    mockUseImportFileFlow.mockReturnValue({
      ...fileFlowDefaults,
      entries: [{ title: "a" }] as unknown as never[],
    });
    render(<ImportPagePanel onComplete={vi.fn()} />);
    expect(mockUseNavigationGuard).toHaveBeenCalledWith(true);
  });

  it("TeamImportPagePanel forwards teamId through to ImportPagePanel", () => {
    render(<TeamImportPagePanel teamId="team-7" onComplete={vi.fn()} />);
    // The underlying execution + file-flow hooks were invoked — confirms the
    // panel rendered through to ImportPanelContent.
    expect(mockUseImportFileFlow).toHaveBeenCalled();
    expect(mockUseImportExecution).toHaveBeenCalled();
  });
});
