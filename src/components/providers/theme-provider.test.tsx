// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockNextThemesProvider } = vi.hoisted(() => ({
  mockNextThemesProvider: vi.fn(),
}));

// boundary: external NPM lib next-themes — passes through children, captures props
vi.mock("next-themes", () => ({
  ThemeProvider: (props: {
    attribute?: string;
    defaultTheme?: string;
    enableSystem?: boolean;
    disableTransitionOnChange?: boolean;
    children: React.ReactNode;
  }) => {
    mockNextThemesProvider(props);
    return <div data-testid="next-themes-root">{props.children}</div>;
  },
}));

import { ThemeProvider } from "./theme-provider";

describe("ThemeProvider", () => {
  it("renders children inside NextThemesProvider", () => {
    render(
      <ThemeProvider>
        <p>child-content</p>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("next-themes-root")).toBeInTheDocument();
    expect(screen.getByText("child-content")).toBeInTheDocument();
  });

  it("passes class attribute, system theme, and transition disable to NextThemesProvider", () => {
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );

    expect(mockNextThemesProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        attribute: "class",
        defaultTheme: "system",
        enableSystem: true,
        disableTransitionOnChange: true,
      }),
    );
  });
});
