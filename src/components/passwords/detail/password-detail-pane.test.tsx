// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { InlineDetailData } from "@/types/entry";

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

describe("PasswordDetailPane", () => {
  it("renders the empty-state when entryId is null (INV-C2.2)", () => {
    render(
      <PasswordDetailPane
        entryId={null}
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

  it("renders nothing (null) when entryId is set but detailData is null and not loading or error", () => {
    const { container } = render(
      <PasswordDetailPane
        entryId="entry-1"
        detailData={null}
        loading={false}
        error={null}
      />,
    );
    // In this transient state (cleared before new fetch), nothing meaningful renders.
    expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
    expect(screen.queryByText("selectAnEntry")).not.toBeInTheDocument();
    // Container is effectively empty
    expect(container.firstChild).toBeNull();
  });
});
