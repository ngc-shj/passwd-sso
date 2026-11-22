// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ExportOptionsPanel } from "@/components/passwords/export/export-options-panel";

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

  it("treats whitespace-only passwords as empty", () => {
    render(<ExportOptionsPanel {...baseProps()} exportPassword="   " confirmPassword="   " />);
    expect(screen.getByRole("button", { name: "exportCsv" })).toBeDisabled();
  });

  it("disables both buttons while an export is running", () => {
    render(<ExportOptionsPanel {...baseProps()} passwordProtect={false} exporting />);
    expect(screen.getByRole("button", { name: "exportCsv" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "exportJson" })).toBeDisabled();
  });

  it("exports CSV from the CSV button", () => {
    const props = baseProps();
    render(<ExportOptionsPanel {...props} passwordProtect={false} />);
    fireEvent.click(screen.getByRole("button", { name: "exportCsv" }));
    expect(props.onExport).toHaveBeenCalledWith("csv");
  });

  it("exports JSON from the JSON button", () => {
    const props = baseProps();
    render(<ExportOptionsPanel {...props} passwordProtect={false} />);
    fireEvent.click(screen.getByRole("button", { name: "exportJson" }));
    expect(props.onExport).toHaveBeenCalledWith("json");
  });

  it("reports a profile change", () => {
    const props = baseProps();
    render(<ExportOptionsPanel {...props} />);
    fireEvent.change(screen.getByLabelText("profileLabel"), { target: { value: "passwd-sso" } });
    expect(props.onExportProfileChange).toHaveBeenCalledWith("passwd-sso");
  });

  it("describes the selected profile", () => {
    const { rerender } = render(<ExportOptionsPanel {...baseProps()} />);
    expect(screen.getByText("profileCompatibleDesc")).toBeInTheDocument();
    rerender(<ExportOptionsPanel {...baseProps()} exportProfile="passwd-sso" />);
    expect(screen.getByText("profilePasswdSsoDesc")).toBeInTheDocument();
    expect(screen.queryByText("profileCompatibleDesc")).not.toBeInTheDocument();
  });

  it("routes the export and confirm password inputs to their own callbacks", () => {
    const props = baseProps();
    render(<ExportOptionsPanel {...props} />);
    fireEvent.change(screen.getByLabelText("exportPassword"), { target: { value: "pw-1" } });
    fireEvent.change(screen.getByLabelText("confirmPassword"), { target: { value: "pw-2" } });
    expect(props.onExportPasswordChange).toHaveBeenCalledWith("pw-1");
    expect(props.onConfirmPasswordChange).toHaveBeenCalledWith("pw-2");
  });

  it("reports the password-protect switch being turned off", () => {
    const props = baseProps();
    render(<ExportOptionsPanel {...props} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(props.onPasswordProtectChange).toHaveBeenCalledWith(false);
  });

  it("hides the password inputs when protection is off", () => {
    render(<ExportOptionsPanel {...baseProps()} passwordProtect={false} />);
    expect(screen.queryByLabelText("exportPassword")).not.toBeInTheDocument();
  });

  it("shows the password error", () => {
    render(<ExportOptionsPanel {...baseProps()} passwordError="mismatch" />);
    expect(screen.getByText("mismatch")).toBeInTheDocument();
  });
});

