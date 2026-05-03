// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, fireEvent, act } from "@testing-library/react";
import { mockTeamMismatch } from "@/__tests__/helpers/mock-app-navigation";

const SENTINEL_NOT_A_SECRET_ZJYK = "SENTINEL_NOT_A_SECRET_ZJYK";

const { mockFetch, mockToast, encryptExportMock } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  encryptExportMock: vi.fn(async () => ({ ciphertext: "ct", iv: "iv", authTag: "tag" })),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/crypto/export-crypto", () => ({
  encryptExport: (...args: unknown[]) => encryptExportMock(...args),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getEntryDecryptionKey: vi.fn(async () => ({})),
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: vi.fn(async () => JSON.stringify({ title: "secret-title", password: "p" })),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: vi.fn(() => "aad"),
}));

vi.mock("@/lib/folder/folder-path", () => ({
  buildFolderPath: vi.fn(() => ""),
}));

vi.mock("@/components/layout/page-pane", () => ({
  PagePane: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

vi.mock("@/components/layout/page-title-card", () => ({
  PageTitleCard: ({ title }: { title: string }) => <div data-testid="title">{title}</div>,
}));

vi.mock("@/components/passwords/export/export-options-panel", () => ({
  ExportOptionsPanel: ({
    onExport,
    passwordError,
    exportPassword,
    onExportPasswordChange,
    onConfirmPasswordChange,
    confirmPassword,
    passwordProtect,
    onPasswordProtectChange,
  }: {
    onExport: (format: "csv" | "json") => void;
    passwordError: string;
    exportPassword: string;
    onExportPasswordChange: (v: string) => void;
    onConfirmPasswordChange: (v: string) => void;
    confirmPassword: string;
    passwordProtect: boolean;
    onPasswordProtectChange: (v: boolean) => void;
  }) => (
    <div>
      <input
        data-testid="exp-pw"
        value={exportPassword}
        onChange={(e) => onExportPasswordChange(e.target.value)}
      />
      <input
        data-testid="exp-confirm"
        value={confirmPassword}
        onChange={(e) => onConfirmPasswordChange(e.target.value)}
      />
      <input
        data-testid="exp-protect"
        type="checkbox"
        checked={passwordProtect}
        onChange={(e) => onPasswordProtectChange(e.target.checked)}
      />
      {passwordError && <span data-testid="error">{passwordError}</span>}
      <button onClick={() => onExport("json")} data-testid="export-json">
        export
      </button>
    </div>
  ),
}));

vi.mock("@/lib/format/export-format-common", () => ({
  TEAM_EXPORT_OPTIONS: {},
  formatExportContent: vi.fn(() => "{}"),
  formatExportDate: vi.fn(() => "2026-05-04"),
}));

import { TeamExportPagePanel } from "./team-export";

describe("TeamExportPagePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
  });

  it("renders nothing when teamId is missing", () => {
    const { container } = render(<TeamExportPagePanel />);
    // PagePane wraps content; the inner Content returns null when teamId missing
    // The header still shows
    expect(container).toBeDefined();
    expect(screen.queryByTestId("export-json")).toBeNull();
  });

  it("renders export panel when teamId provided", () => {
    render(<TeamExportPagePanel teamId="team-1" />);
    expect(screen.getByTestId("export-json")).toBeInTheDocument();
  });

  it("rejects short export password", async () => {
    render(<TeamExportPagePanel teamId="team-1" />);
    const pwInput = screen.getByTestId("exp-pw");
    fireEvent.change(pwInput, { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("exp-confirm"), { target: { value: "short" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-json"));
    });
    expect(screen.getByTestId("error")).toHaveTextContent("passwordTooShort");
  });

  it("rejects mismatched confirm password", async () => {
    render(<TeamExportPagePanel teamId="team-1" />);
    fireEvent.change(screen.getByTestId("exp-pw"), { target: { value: "longpassword1" } });
    fireEvent.change(screen.getByTestId("exp-confirm"), { target: { value: "different" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-json"));
    });
    expect(screen.getByTestId("error")).toHaveTextContent("passwordMismatch");
  });

  // §Sec-2: secret input must NOT leak into rendered DOM on error
  it("does not leak the export password sentinel into the DOM on validation failure", async () => {
    render(<TeamExportPagePanel teamId="team-1" />);
    fireEvent.change(screen.getByTestId("exp-pw"), {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });
    fireEvent.change(screen.getByTestId("exp-confirm"), { target: { value: "different" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-json"));
    });
    // Error rendered, but sentinel value not in any error message
    expect(screen.getByTestId("error")).toBeInTheDocument();
    // The sentinel only exists inside the input value; it must not appear in
    // any other rendered text node.
    const allText = document.body.textContent ?? "";
    // Input values aren't part of textContent, so the sentinel should be absent.
    expect(allText).not.toContain(SENTINEL_NOT_A_SECRET_ZJYK);
  });

  // §Sec-3: cross-tenant rendering does not crash
  it("renders without crash under cross-tenant context", () => {
    const ctx = mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" });
    expect(ctx.useTeamVault().currentTeamId).not.toBe(ctx.teamId);
    render(<TeamExportPagePanel teamId={ctx.teamId} />);
    expect(screen.getByTestId("export-json")).toBeInTheDocument();
  });
});
