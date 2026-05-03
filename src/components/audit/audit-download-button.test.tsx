// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AuditDownloadButton } from "./audit-download-button";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Replace the dropdown menu with a simple div so children render unconditionally.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <span>{children}</span>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("AuditDownloadButton", () => {
  it("disables the button and shows exportDisabled tooltip when exportAllowed=false (R26 disabled cue)", () => {
    render(
      <AuditDownloadButton
        downloading={false}
        onDownload={vi.fn()}
        exportAllowed={false}
      />,
    );
    expect(screen.getByRole("button", { name: /download/ })).toBeDisabled();
    expect(screen.getByText("exportDisabled")).toBeInTheDocument();
  });

  it("disables the trigger button while downloading and renders the downloading label (R26 cue)", () => {
    render(
      <AuditDownloadButton downloading={true} onDownload={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /downloading/ })).toBeDisabled();
  });

  it("invokes onDownload('csv') when CSV item is clicked", () => {
    const onDownload = vi.fn();
    render(<AuditDownloadButton downloading={false} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "formatCsv" }));
    expect(onDownload).toHaveBeenCalledWith("csv");
  });

  it("invokes onDownload('jsonl') when JSONL item is clicked", () => {
    const onDownload = vi.fn();
    render(<AuditDownloadButton downloading={false} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "formatJsonl" }));
    expect(onDownload).toHaveBeenCalledWith("jsonl");
  });
});
