// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ENTRY_TYPE } from "@/lib/constants";

// Polyfill ResizeObserver for jsdom (needed by Dropdown/Popper primitives).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("../shared/copy-button", () => ({
  // Surface ariaLabel so tests can assert the quick-copy button says WHAT it copies.
  CopyButton: ({ ariaLabel }: { ariaLabel?: string }) => (
    <button type="button" data-testid="copy-btn" aria-label={ariaLabel}>copy</button>
  ),
}));

import { EntryActionsMenu } from "./entry-actions-menu";

const noopFetch = () => Promise.resolve("");
const noopFetchField = (_field: string) => Promise.resolve("");

// A COMPLETE prop set including every manage callback + capability flag, so the
// accelerator-variant test proves the `variant` gate itself suppresses manage items
// (INV-C1.2) — not merely that the caller forgot to pass them.
const fullProps = {
  entryType: ENTRY_TYPE.LOGIN,
  username: "alice",
  urlHost: "github.com",
  isArchived: false,
  canEdit: true,
  canDelete: true,
  canShare: true,
  fetchPassword: noopFetch,
  fetchCardField: noopFetchField as (field: "cardNumber" | "cvv") => Promise<string>,
  fetchIdentityField: noopFetchField as (field: "idNumber") => Promise<string>,
  fetchPasskeyField: noopFetchField as (field: "credentialId" | "username") => Promise<string>,
  fetchBankField: noopFetchField as (field: "accountNumber" | "routingNumber") => Promise<string>,
  fetchLicenseField: noopFetchField as (field: "licenseKey") => Promise<string>,
  fetchSshField: noopFetchField as (field: "fingerprint" | "publicKey") => Promise<string>,
  onCopyUsername: vi.fn(),
  onCopyPassword: vi.fn(),
  onCopyContent: vi.fn(),
  onCopyCardNumber: vi.fn(),
  onCopyCvv: vi.fn(),
  onCopyCredentialId: vi.fn(),
  onCopyAccountNumber: vi.fn(),
  onCopyLicenseKey: vi.fn(),
  onCopyFingerprint: vi.fn(),
  onCopyPublicKey: vi.fn(),
  onCopyIdNumber: vi.fn(),
  onOpenUrl: vi.fn(),
  onShare: vi.fn(),
  onEdit: vi.fn(),
  onToggleArchive: vi.fn(),
  onDeleteRequest: vi.fn(),
  onRestore: vi.fn(),
  onDeletePermanently: vi.fn(),
  t: (key: string) => key,
};

describe("EntryActionsMenu — variant gate", () => {
  // INV-C1.2 (the security-relevant invariant): the accelerator variant renders ZERO
  // manage items even when every manage callback IS forwarded. This isolates the
  // `variant` gate — a regression that re-wires a manage action onto the row (or
  // removes the gate) is caught here, independent of which props the row happens to pass.
  it("accelerator: copy items present, ALL manage items absent even when callbacks are provided", async () => {
    const user = userEvent.setup();
    render(<EntryActionsMenu {...fullProps} variant="accelerator" />);

    await user.click(screen.getByText("moreActions"));
    // Copy items remain (proves the menu opened).
    expect(screen.getByText("copyPassword")).toBeInTheDocument();
    // Every manage item is suppressed by the variant gate.
    expect(screen.queryByText("share")).not.toBeInTheDocument();
    expect(screen.queryByText("edit")).not.toBeInTheDocument();
    expect(screen.queryByText("archive")).not.toBeInTheDocument();
    expect(screen.queryByText("delete")).not.toBeInTheDocument();
    expect(screen.queryByText("restore")).not.toBeInTheDocument();
    expect(screen.queryByText("deletePermanently")).not.toBeInTheDocument();
  });

  it("full: copy items AND manage items render when callbacks/flags are provided", async () => {
    const user = userEvent.setup();
    render(<EntryActionsMenu {...fullProps} variant="full" />);

    await user.click(screen.getByText("moreActions"));
    expect(screen.getByText("copyPassword")).toBeInTheDocument();
    expect(screen.getByText("share")).toBeInTheDocument();
    expect(screen.getByText("edit")).toBeInTheDocument();
    expect(screen.getByText("delete")).toBeInTheDocument();
  });

  // The quick-copy button must say WHAT it copies (per entry type) — not a generic
  // "Copy" — so users know what lands on the clipboard (tooltip + accessible name).
  it.each([
    [ENTRY_TYPE.LOGIN, "copyPassword"],
    [ENTRY_TYPE.CREDIT_CARD, "copyCardNumber"],
    [ENTRY_TYPE.IDENTITY, "copyIdNumber"],
    [ENTRY_TYPE.PASSKEY, "copyCredentialId"],
    [ENTRY_TYPE.BANK_ACCOUNT, "copyAccountNumber"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "copyLicenseKey"],
    [ENTRY_TYPE.SSH_KEY, "copyFingerprint"],
  ])("quick-copy for %s has the descriptive label %s", (entryType, label) => {
    render(<EntryActionsMenu {...fullProps} entryType={entryType} variant="accelerator" />);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("defaults to full when variant is omitted (no behavior change for existing callers)", async () => {
    const user = userEvent.setup();
    render(<EntryActionsMenu {...fullProps} />);

    await user.click(screen.getByText("moreActions"));
    expect(screen.getByText("edit")).toBeInTheDocument();
    expect(screen.getByText("delete")).toBeInTheDocument();
  });
});
