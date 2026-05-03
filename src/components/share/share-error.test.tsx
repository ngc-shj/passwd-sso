// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ShareError } from "./share-error";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("ShareError", () => {
  it("renders the error_<reason>_title and _desc i18n keys", () => {
    render(<ShareError reason="expired" />);
    expect(screen.getByText("error_expired_title")).toBeInTheDocument();
    expect(screen.getByText("error_expired_desc")).toBeInTheDocument();
  });

  it("renders an SVG icon for the supplied reason", () => {
    const { container } = render(<ShareError reason="revoked" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("falls back to notFound icon when reason is unknown (prevents missing icon crash)", () => {
    const { container } = render(<ShareError reason="totally-unknown" />);
    // Icon container exists with SVG fallback
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("error_totally-unknown_title")).toBeInTheDocument();
  });

  it.each([
    "notFound",
    "expired",
    "revoked",
    "maxViews",
    "rateLimited",
    "missingKey",
    "decryptFailed",
  ])("renders an icon for known reason '%s'", (reason) => {
    const { container } = render(<ShareError reason={reason} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
