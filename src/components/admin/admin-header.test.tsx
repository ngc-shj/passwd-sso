// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { mockI18nNavigation } from "@/__tests__/helpers/mock-app-navigation";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () =>
  mockI18nNavigation({
    Link: ({ href, children, ...rest }) => (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
  }),
);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-label": ariaLabel,
  }: React.ComponentProps<"button">) => (
    <button onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

import { AdminHeader } from "./admin-header";

describe("AdminHeader", () => {
  it("renders title and back-to-vault link", () => {
    render(<AdminHeader onMenuToggle={vi.fn()} />);

    expect(screen.getByText("title")).toBeInTheDocument();
    expect(screen.getByText(/backToVault/)).toBeInTheDocument();
  });

  it("calls onMenuToggle when the menu button is clicked", () => {
    const onMenuToggle = vi.fn();
    render(<AdminHeader onMenuToggle={onMenuToggle} />);

    fireEvent.click(screen.getByRole("button", { name: "openMenu" }));
    expect(onMenuToggle).toHaveBeenCalled();
  });
});
