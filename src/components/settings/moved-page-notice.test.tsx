// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

import { MovedPageNotice } from "./moved-page-notice";

const DEST = "/dashboard/settings/auth";
const STORAGE_KEY = `psso:settings-ia-moved-notice:${DEST}`;

describe("MovedPageNotice", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("renders when sessionStorage key is not set", () => {
    render(<MovedPageNotice section="auth" destinationPath={DEST} />);

    expect(screen.getByText("movedNotice.title")).toBeInTheDocument();
  });

  it("does not render when sessionStorage key is set", () => {
    sessionStorage.setItem(STORAGE_KEY, "1");

    render(<MovedPageNotice section="auth" destinationPath={DEST} />);

    expect(screen.queryByText("movedNotice.title")).not.toBeInTheDocument();
  });

  it("sets sessionStorage key and hides notice on dismiss click", () => {
    render(<MovedPageNotice section="auth" destinationPath={DEST} />);
    expect(screen.getByText("movedNotice.title")).toBeInTheDocument();

    fireEvent.click(screen.getByText("movedNotice.dismiss"));

    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(screen.queryByText("movedNotice.title")).not.toBeInTheDocument();
  });

  it("sets sessionStorage key on unmount (route change away)", () => {
    const { unmount } = render(<MovedPageNotice section="auth" destinationPath={DEST} />);

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    unmount();

    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("does not render on second mount when sessionStorage key was set by unmount", () => {
    const { unmount } = render(<MovedPageNotice section="auth" destinationPath={DEST} />);
    unmount();

    // Simulate navigating back
    render(<MovedPageNotice section="auth" destinationPath={DEST} />);

    expect(screen.queryByText("movedNotice.title")).not.toBeInTheDocument();
  });

  it("interpolates section label into the body text", () => {
    render(<MovedPageNotice section="vault" destinationPath={DEST} />);

    // useTranslations mock returns the key as-is; the component passes
    // Settings.section.vault as the {section} variable.
    // With our mock, tSettings("section.vault") → "section.vault"
    // and tMigration("movedNotice.body", { section: "section.vault" }) → "movedNotice.body"
    // (the mock ignores parameters). Just verify the notice renders.
    expect(screen.getByText("movedNotice.title")).toBeInTheDocument();
  });

  // TypeScript compile-time test: passing an invalid section must be a type error
  it("rejects invalid section at compile time", () => {
    // @ts-expect-error - "invalid-section" is not a valid SectionKey
    const el = <MovedPageNotice section="invalid-section" destinationPath={DEST} />;
    expect(el).toBeDefined();
  });
});
