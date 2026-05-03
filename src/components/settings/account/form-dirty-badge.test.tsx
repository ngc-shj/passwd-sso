// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { FormDirtyBadge } from "./form-dirty-badge";

describe("FormDirtyBadge", () => {
  it("renders the unsaved label when hasChanges is true", () => {
    render(
      <FormDirtyBadge
        hasChanges={true}
        unsavedLabel="Unsaved"
        savedLabel="Saved"
      />,
    );
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("renders the saved label when hasChanges is false", () => {
    render(
      <FormDirtyBadge
        hasChanges={false}
        unsavedLabel="Unsaved"
        savedLabel="Saved"
      />,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("uses amber styling when dirty", () => {
    const { container } = render(
      <FormDirtyBadge
        hasChanges={true}
        unsavedLabel="Unsaved"
        savedLabel="Saved"
      />,
    );
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toMatch(/bg-amber-100/);
    expect(badge.className).not.toMatch(/bg-emerald-100/);
  });

  it("uses emerald styling when clean", () => {
    const { container } = render(
      <FormDirtyBadge
        hasChanges={false}
        unsavedLabel="Unsaved"
        savedLabel="Saved"
      />,
    );
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toMatch(/bg-emerald-100/);
    expect(badge.className).not.toMatch(/bg-amber-100/);
  });
});
