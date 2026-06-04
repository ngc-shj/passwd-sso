// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ENTRY_TYPE } from "@/lib/constants";
import type { DisplayEntry } from "./password-list";

// Polyfill ResizeObserver for jsdom (needed by Dropdown primitives)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../shared/favicon", () => ({
  Favicon: ({ host }: { host: string | null }) => (
    <span data-testid="favicon">{host}</span>
  ),
}));

vi.mock("@/components/tags/tag-badge", () => ({
  TagBadge: ({ name }: { name: string }) => (
    <span data-testid="tag-badge">{name}</span>
  ),
}));

vi.mock("../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy-btn">copy</button>,
}));

import { PasswordRow } from "./password-row";
// Also import EntrySecondaryLine to render it directly for the parity test.
import { EntrySecondaryLine } from "./entry-secondary-line";

// Noop fetch callbacks used across tests.
const noopFetch = () => Promise.resolve("");
const noopFetchField =
  (_field: string) => Promise.resolve("");

function makeEntry(overrides: Partial<DisplayEntry> = {}): DisplayEntry {
  return {
    id: "e1",
    entryType: ENTRY_TYPE.LOGIN,
    title: "GitHub",
    username: "alice",
    urlHost: "github.com",
    snippet: null,
    brand: null,
    lastFour: null,
    cardholderName: null,
    fullName: null,
    idNumberLast4: null,
    relyingPartyId: null,
    bankName: null,
    accountNumberLast4: null,
    softwareName: null,
    licensee: null,
    keyType: null,
    fingerprint: null,
    tags: [],
    isFavorite: false,
    isArchived: false,
    requireReprompt: false,
    travelSafe: true,
    expiresAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const defaultRowProps = {
  fetchPassword: noopFetch,
  fetchContent: noopFetch,
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
};

describe("PasswordRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the entry title", () => {
    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );
    expect(screen.getByTestId("row-title")).toHaveTextContent("GitHub");
  });

  it("renders the secondary line with username/urlHost for a login entry", () => {
    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );
    const secondary = screen.getByTestId("row-secondary-line");
    expect(secondary).toBeInTheDocument();
    expect(secondary).toHaveTextContent("alice");
  });

  it("calls onActivate when the row is clicked (not in selectionMode)", async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={onActivate}
        {...defaultRowProps}
      />,
    );

    await user.click(screen.getByTestId("row-title"));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("does NOT call onActivate in selectionMode (INV-C4.1)", async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={onActivate}
        selectionMode={true}
        {...defaultRowProps}
      />,
    );

    await user.click(screen.getByTestId("row-title"));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("active row has aria-current='true' and aria-selected=true (real a11y, not only styling)", () => {
    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={true}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );

    const row = screen.getByRole("option");
    // Real aria attribute — not only a styling class (feedback_e2e_aria_label_phantom_match)
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("inactive row does NOT have aria-current or aria-selected=true", () => {
    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );

    const row = screen.getByRole("option");
    expect(row).not.toHaveAttribute("aria-current");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("renders the overflow menu button (EntryActionsMenu present)", () => {
    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );
    // The MoreVertical menu trigger has sr-only text "moreActions"
    expect(screen.getByText("moreActions")).toBeInTheDocument();
  });

  it("renders tags on line 2", () => {
    render(
      <PasswordRow
        entry={makeEntry({ tags: [{ name: "Work", color: null }, { name: "Personal", color: null }] })}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );
    const tags = screen.getAllByTestId("tag-badge");
    expect(tags).toHaveLength(2);
    expect(tags[0]).toHaveTextContent("Work");
    expect(tags[1]).toHaveTextContent("Personal");
  });

  it("shows overflow indicator when tags exceed MAX_VISIBLE_TAGS (3)", () => {
    const manyTags = [
      { name: "A", color: null },
      { name: "B", color: null },
      { name: "C", color: null },
      { name: "D", color: null },
      { name: "E", color: null },
    ];
    render(
      <PasswordRow
        entry={makeEntry({ tags: manyTags })}
        isActive={false}
        onActivate={vi.fn()}
        {...defaultRowProps}
      />,
    );
    // Only 3 tag badges visible
    expect(screen.getAllByTestId("tag-badge")).toHaveLength(3);
    // Overflow indicator
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  // ── T6: no hover-decrypt (INV-C1.2/T8) ───────────────────────────────────────
  // Hovering the row must NOT call onActivate (no decrypt-on-hover).
  // INV-C1.2: decryption is only triggered by explicit user selection.

  it("T6 INV-C1.2: hovering the row does NOT call onActivate (no hover-decrypt)", async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordRow
        entry={makeEntry()}
        isActive={false}
        onActivate={onActivate}
        {...defaultRowProps}
      />,
    );

    // Hover the row title area
    await user.hover(screen.getByTestId("row-title"));

    // onActivate must NOT have been called by hover — only by explicit click
    expect(onActivate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// T12/T15: Anti-drift parity test (INV-C6.4)
//
// For each of the 8 entry types, render BOTH the rich card's EntrySecondaryLine
// (the source of truth) AND the compact PasswordRow's secondary line using the
// SAME entry fixture, then assert the two secondary-line texts are EQUAL to
// each other. This guards against PasswordRow re-implementing the 8-type switch
// differently than EntrySecondaryLine.
//
// We query via data-testid="row-secondary-line" on PasswordRow and render
// EntrySecondaryLine directly for the reference value.
// ──────────────────────────────────────────────────────────────────────────────
describe("PasswordRow secondary-line parity with EntrySecondaryLine (T12/T15, INV-C6.4)", () => {
  // Fixture covering all 8 entry types with representative secondary-line values.
  const fixtures: Array<{
    label: string;
    entry: DisplayEntry;
    // Props forwarded to EntrySecondaryLine for the reference render.
    secondaryLineProps: Parameters<typeof EntrySecondaryLine>[0];
  }> = [
    {
      label: "LOGIN",
      entry: makeEntry({ entryType: ENTRY_TYPE.LOGIN, username: "alice", urlHost: "github.com" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.LOGIN, username: "alice", urlHost: "github.com" },
    },
    {
      label: "SECURE_NOTE",
      entry: makeEntry({ entryType: ENTRY_TYPE.SECURE_NOTE, snippet: "This is a note" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.SECURE_NOTE, snippet: "This is a note" },
    },
    {
      label: "CREDIT_CARD",
      entry: makeEntry({
        entryType: ENTRY_TYPE.CREDIT_CARD,
        brand: "Visa",
        lastFour: "4242",
        cardholderName: "Alice Smith",
      }),
      secondaryLineProps: {
        entryType: ENTRY_TYPE.CREDIT_CARD,
        brand: "Visa",
        lastFour: "4242",
        cardholderName: "Alice Smith",
      },
    },
    {
      label: "IDENTITY",
      entry: makeEntry({ entryType: ENTRY_TYPE.IDENTITY, fullName: "Alice Smith", idNumberLast4: "7890" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.IDENTITY, fullName: "Alice Smith", idNumberLast4: "7890" },
    },
    {
      label: "PASSKEY",
      entry: makeEntry({ entryType: ENTRY_TYPE.PASSKEY, relyingPartyId: "example.com", username: "alice" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.PASSKEY, relyingPartyId: "example.com", username: "alice" },
    },
    {
      label: "BANK_ACCOUNT",
      entry: makeEntry({ entryType: ENTRY_TYPE.BANK_ACCOUNT, bankName: "Chase", accountNumberLast4: "1234" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.BANK_ACCOUNT, bankName: "Chase", accountNumberLast4: "1234" },
    },
    {
      label: "SOFTWARE_LICENSE",
      entry: makeEntry({ entryType: ENTRY_TYPE.SOFTWARE_LICENSE, softwareName: "VS Code", licensee: "alice@example.com" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.SOFTWARE_LICENSE, softwareName: "VS Code", licensee: "alice@example.com" },
    },
    {
      label: "SSH_KEY",
      entry: makeEntry({ entryType: ENTRY_TYPE.SSH_KEY, keyType: "ed25519", fingerprint: "SHA256:abcdef1234567890" }),
      secondaryLineProps: { entryType: ENTRY_TYPE.SSH_KEY, keyType: "ed25519", fingerprint: "SHA256:abcdef1234567890" },
    },
  ];

  for (const { label, entry, secondaryLineProps } of fixtures) {
    it(`${label}: compact row secondary line matches EntrySecondaryLine reference`, () => {
      // Render the compact row and capture its secondary line text.
      const { unmount: unmountRow, getByTestId } = render(
        <PasswordRow
          entry={entry}
          isActive={false}
          onActivate={vi.fn()}
          {...defaultRowProps}
        />,
      );
      const compactText = getByTestId("row-secondary-line").textContent ?? "";
      unmountRow();

      // Render the reference EntrySecondaryLine directly and capture its text.
      const { container: refContainer, unmount: unmountRef } = render(
        <div data-testid="ref-secondary-line">
          <EntrySecondaryLine {...secondaryLineProps} />
        </div>,
      );
      const refText = (refContainer.querySelector("[data-testid='ref-secondary-line']") as HTMLElement)
        ?.textContent ?? "";
      unmountRef();

      // The two must be identical — any drift in the 8-type switch fails this test.
      expect(compactText).toEqual(refText);
    });
  }
});
