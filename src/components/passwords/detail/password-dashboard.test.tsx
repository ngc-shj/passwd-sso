// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/layout/search-bar", () => ({
  SearchBar: () => <div data-testid="search-bar" />,
}));

vi.mock("@/components/passwords/detail/password-list", () => ({
  PasswordList: () => <div data-testid="password-list" />,
}));

vi.mock("@/components/passwords/shared/trash-list", () => ({
  TrashList: () => <div data-testid="trash-list" />,
}));

vi.mock("@/components/passwords/dialogs/personal-password-new-dialog", () => ({
  PasswordNewDialog: () => null,
}));

vi.mock("@/hooks/personal/use-personal-folders", () => ({
  usePersonalFolders: () => ({ folders: [] }),
}));

vi.mock("@/hooks/personal/use-personal-tags", () => ({
  usePersonalTags: () => ({ tags: [] }),
}));

vi.mock("@/components/extension/auto-extension-connect", () => ({
  isOverlayActive: () => false,
}));

import { PasswordDashboard } from "./password-dashboard";

describe("PasswordDashboard", () => {
  it("renders the search bar and password list for the all view", () => {
    render(<PasswordDashboard view="all" />);

    expect(screen.getByTestId("search-bar")).toBeInTheDocument();
    expect(screen.getByTestId("password-list")).toBeInTheDocument();
    expect(screen.queryByTestId("trash-list")).not.toBeInTheDocument();
  });

  it("renders the trash list for the trash view", () => {
    render(<PasswordDashboard view="trash" />);

    expect(screen.getByTestId("trash-list")).toBeInTheDocument();
    expect(screen.queryByTestId("password-list")).not.toBeInTheDocument();
  });

  it("uses the favorites subtitle when view=favorites", () => {
    render(<PasswordDashboard view="favorites" />);
    // Subtitle is "favorites" (translation key passthrough)
    expect(screen.getByText("favorites")).toBeInTheDocument();
  });
});
