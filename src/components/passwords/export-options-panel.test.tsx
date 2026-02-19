// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ExportOptionsPanel } from "@/components/passwords/export-options-panel";

function baseProps() {
  return {
    t: (key: string) => key,
    exportProfile: "compatible" as const,
    onExportProfileChange: vi.fn(),
    passwordProtect: true,
    onPasswordProtectChange: vi.fn(),
    exportPassword: "",
    onExportPasswordChange: vi.fn(),
    confirmPassword: "",
    onConfirmPasswordChange: vi.fn(),
    passwordError: "",
    exporting: false,
    onExport: vi.fn(),
  };
}

describe("ExportOptionsPanel", () => {
  it("disables CSV/JSON buttons when password protection is on and password inputs are empty", () => {
    render(<ExportOptionsPanel {...baseProps()} />);

    expect(screen.getByRole("button", { name: "exportCsv" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "exportJson" })).toBeDisabled();
  });

  it("enables CSV/JSON buttons when password protection is on and both password inputs are filled", () => {
    render(
      <ExportOptionsPanel
        {...baseProps()}
        exportPassword="very-strong-passphrase"
        confirmPassword="very-strong-passphrase"
      />
    );

    expect(screen.getByRole("button", { name: "exportCsv" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "exportJson" })).toBeEnabled();
  });

  it("disables CSV/JSON buttons when password protection is on and passwords do not match", () => {
    render(
      <ExportOptionsPanel
        {...baseProps()}
        exportPassword="very-strong-passphrase"
        confirmPassword="different-passphrase"
      />
    );

    expect(screen.getByRole("button", { name: "exportCsv" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "exportJson" })).toBeDisabled();
  });

  it("enables CSV/JSON buttons when password protection is off", () => {
    render(
      <ExportOptionsPanel
        {...baseProps()}
        passwordProtect={false}
      />
    );

    expect(screen.getByRole("button", { name: "exportCsv" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "exportJson" })).toBeEnabled();
  });
});
