// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSetTheme = vi.fn();
const mockUseTheme = vi.fn();

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      themeSystem: "System",
    };
    return map[key] ?? key;
  },
}));

import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTheme.mockReturnValue({
      theme: "light",
      setTheme: mockSetTheme,
      resolvedTheme: "light",
    });
  });

  it("renders toggle button with aria-label", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Theme" })).toBeDefined();
  });

  it("shows three options when clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Theme" }));

    expect(screen.getByText("Light")).toBeDefined();
    expect(screen.getByText("Dark")).toBeDefined();
    expect(screen.getByText("System")).toBeDefined();
  });

  it("calls setTheme('dark') when Dark is clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(screen.getByText("Dark"));

    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("calls setTheme('light') when Light is clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(screen.getByText("Light"));

    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("calls setTheme('system') when System is clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(screen.getByText("System"));

    expect(mockSetTheme).toHaveBeenCalledWith("system");
  });
});
