// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { EntryDialogShell } from "./entry-dialog-shell";

describe("EntryDialogShell", () => {
  it("renders the title and children when open", () => {
    render(
      <EntryDialogShell open={true} onOpenChange={vi.fn()} title="Edit Entry">
        <div>body</div>
      </EntryDialogShell>,
    );

    // Title is rendered both as heading and screen-reader-only description
    expect(screen.getAllByText("Edit Entry").length).toBeGreaterThan(0);
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("does not render dialog content when closed", () => {
    render(
      <EntryDialogShell open={false} onOpenChange={vi.fn()} title="Edit">
        <div>body</div>
      </EntryDialogShell>,
    );

    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });
});
