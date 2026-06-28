/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FillMismatchDialog } from "../../popup/components/FillMismatchDialog";

describe("FillMismatchDialog", () => {
  const baseProps = {
    title: "Bank Login",
    savedHost: "bank.example.com",
    currentHost: "evil-phish.com",
    onConfirm: () => {},
    onCancel: () => {},
  };

  it("renders the warning, saved host, and current host", () => {
    render(<FillMismatchDialog {...baseProps} />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Fill on a different site?")).toBeInTheDocument();
    expect(screen.getByText("Bank Login is saved for:", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("bank.example.com", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("This site is:", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("evil-phish.com", { exact: false })).toBeInTheDocument();
  });

  it("omits the current-site line when currentHost is null", () => {
    render(<FillMismatchDialog {...baseProps} currentHost={null} />);

    expect(screen.getByText("Bank Login is saved for:", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("This site is:", { exact: false })).toBeNull();
  });

  it("calls onConfirm when 'Fill anyway' is clicked", () => {
    const onConfirm = vi.fn();
    render(<FillMismatchDialog {...baseProps} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "Fill anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when 'Cancel' is clicked", () => {
    const onCancel = vi.fn();
    render(<FillMismatchDialog {...baseProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders an empty saved host without crashing", () => {
    render(<FillMismatchDialog {...baseProps} savedHost="" />);
    // Title line still renders; the host portion is just empty.
    expect(screen.getByText("Bank Login is saved for:", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill anyway" })).toBeInTheDocument();
  });
});
