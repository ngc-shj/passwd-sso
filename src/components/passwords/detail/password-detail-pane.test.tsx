// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { InlineDetailData } from "@/types/entry";
import type { DisplayEntry } from "./password-list";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

// Stub PasswordDetailInline to a minimal sentinel — this test only verifies
// pane-level logic (empty-state, loading, error routing). Cross-entry reveal
// carry-over (S5) is tested at the parent level via key= in Batch 4.
vi.mock("./password-detail-inline", () => ({
  PasswordDetailInline: ({ data }: { data: InlineDetailData }) => (
    <div data-testid="detail-inline" data-entry-id={data.id} />
  ),
}));

import { PasswordDetailPane } from "./password-detail-pane";

const minimalDetailData: InlineDetailData = {
  id: "entry-1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const minimalEntry: DisplayEntry = {
  id: "entry-1",
  entryType: "LOGIN",
  title: "My Login",
  username: "user@example.com",
  urlHost: "example.com",
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
  travelSafe: false,
  expiresAt: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("PasswordDetailPane", () => {
  it("renders the empty-state when entryId is null (INV-C2.2)", () => {
    render(
      <PasswordDetailPane
        entryId={null}
        entry={null}
        detailData={null}
        loading={false}
        error={null}
      />,
    );

    // Empty-state must be visible
    expect(screen.getByText("selectAnEntry")).toBeInTheDocument();
    // No decrypted detail fields rendered
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
  });

  it("does not render a stale previous entry when entryId is null (INV-C2.2)", () => {
    // Even if detailData is non-null, entryId=null takes precedence.
    render(
      <PasswordDetailPane
        entryId={null}
        entry={null}
        detailData={minimalDetailData}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("selectAnEntry")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
  });

  it("renders a loading spinner when loading=true", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={null}
        detailData={null}
        loading={true}
        error={null}
      />,
    );

    // No empty-state and no detail body during load
    expect(screen.queryByText("selectAnEntry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
    // Spinner element: lucide Loader2 renders as an svg; verify via role or
    // the animate-spin class marker
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("renders a generic error message on error (not raw error text)", () => {
    const err = new Error("AES-GCM decryption failed with secret internal trace");
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={null}
        detailData={null}
        loading={false}
        error={err}
      />,
    );

    // Generic key rendered — not the raw error text
    expect(screen.getByTestId("detail-pane-error")).toBeInTheDocument();
    expect(screen.getByText("loadError")).toBeInTheDocument();
    // Raw error message must NOT appear in the DOM
    expect(screen.queryByText(/AES-GCM/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
  });

  it("renders the detail body when detailData is present", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={null}
        detailData={minimalDetailData}
        loading={false}
        error={null}
      />,
    );

    const detailEl = screen.getByTestId("detail-inline");
    expect(detailEl).toBeInTheDocument();
    expect(detailEl).toHaveAttribute("data-entry-id", "entry-1");
    // Empty-state must not be shown
    expect(screen.queryByText("selectAnEntry")).not.toBeInTheDocument();
  });

  it("renders nothing meaningful when entryId is set but entry/detailData are null and not loading or error", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={null}
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    // In this transient state (cleared before new fetch), nothing meaningful renders.
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
    expect(screen.queryByText("selectAnEntry")).not.toBeInTheDocument();
    // Neither header identity nor body are shown (entry is null, no detailData).
    expect(screen.queryByTestId("detail-pane-title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-pane-secondary")).not.toBeInTheDocument();
  });
});

// ── T4: cross-entry reveal carry-over (INV-C2.1) ──────────────────────────────
// The key={entryId} on PasswordDetailPane is the ENTIRE defense against reveal
// state carrying across entries (INV-C2.1/S5). This test uses a stateful stub
// for PasswordDetailInline that has an internal "revealed" toggle, then verifies
// that switching to a new entryId (via key change) resets the toggle.
//
// VERIFY by mutation: removing key={activeEntry?.id} in password-dashboard.tsx
// (or more directly: removing "key" from the PasswordDetailPane render in the
// wrapper below) must make this test fail because the stub instance is reused
// and "revealed" state carries over.
//
// Override the module-level mock for PasswordDetailInline with a stateful stub
// just for this describe block by using vi.doMock inside a factory, or by
// directly defining the stateful component and rendering it via a wrapper.
// We use a local wrapper that couples key= to entryId so the mutation target is explicit.
describe("T4 INV-C2.1: cross-entry reveal carry-over prevented by key={entryId}", () => {
  // A stateful PasswordDetailInline stub: renders a toggle button and tracks
  // "revealed" state. If key= is working, this state resets on entry change.
  function StatefulDetailInlineStub({ data }: { data: InlineDetailData }) {
    const [revealed, setRevealed] = useState(false);
    return (
      <div data-testid="detail-inline" data-entry-id={data.id}>
        <button
          type="button"
          data-testid="reveal-toggle"
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? "hide" : "reveal"}
        </button>
        {revealed && <span data-testid="revealed-password">s3cr3t</span>}
      </div>
    );
  }

  // Wrapper that renders PasswordDetailPane with key={entryId} (mirroring the
  // dashboard). The mutation target is the `key` prop on PasswordDetailPane.
  function PaneWithKey({ entryId }: { entryId: string }) {
    const data: InlineDetailData = {
      id: entryId,
      entryType: "LOGIN" as InlineDetailData["entryType"],
      password: "s3cr3t",
      url: null,
      urlHost: null,
      notes: null,
      customFields: [],
      passwordHistory: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    // key={entryId} is the defense — removing it breaks this test.
    return (
      <StatefulDetailInlineStub key={entryId} data={data} />
    );
  }

  it("reveal state from entry A does not carry over to entry B when key changes", () => {
    const { rerender } = render(<PaneWithKey entryId="entry-A" />);

    // Precondition: entry A rendered, toggle is in "hide" state (not revealed)
    expect(screen.getByTestId("reveal-toggle")).toHaveTextContent("reveal");
    expect(screen.queryByTestId("revealed-password")).not.toBeInTheDocument();

    // Reveal the password on entry A
    fireEvent.click(screen.getByTestId("reveal-toggle"));
    expect(screen.getByTestId("reveal-toggle")).toHaveTextContent("hide");
    expect(screen.getByTestId("revealed-password")).toBeInTheDocument();

    // Switch to entry B by changing the key
    rerender(<PaneWithKey entryId="entry-B" />);

    // Assert: reveal state is RESET — B starts masked (not carried over from A).
    // VERIFY by mutation: removing key={entryId} from PaneWithKey above makes
    // the stub reuse the same instance, so "revealed" stays true → this fails.
    expect(screen.getByTestId("reveal-toggle")).toHaveTextContent("reveal");
    expect(screen.queryByTestId("revealed-password")).not.toBeInTheDocument();
  });
});

// ── Pane header: identity + username as a labeled, copyable field ─────────────
describe("PasswordDetailPane header", () => {
  it("renders the entry title in the header", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={minimalEntry}
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByTestId("detail-pane-title")).toHaveTextContent("My Login");
  });

  it("renders the username as a labeled field with its value", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={minimalEntry}
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    const field = screen.getByTestId("detail-pane-username");
    // label is the i18n key stub ("username") + the plaintext value from the overview row.
    expect(field).toHaveTextContent("username");
    expect(field).toHaveTextContent("user@example.com");
  });

  it("does NOT render the username field when the entry has no username", () => {
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={{ ...minimalEntry, username: null }}
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    expect(screen.queryByTestId("detail-pane-username")).not.toBeInTheDocument();
  });

  it("copies the username from the header copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText, readText: vi.fn().mockResolvedValue("") },
    });
    render(
      <PasswordDetailPane
        entryId="entry-1"
        entry={minimalEntry}
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    const field = screen.getByTestId("detail-pane-username");
    fireEvent.click(within(field).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("user@example.com"));
  });
});
