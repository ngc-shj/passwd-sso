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
    nonce?: string;
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

  // next-themes emits an inline <script> during SSR and creates a <style> at
  // runtime for disableTransitionOnChange. Under the production CSP both are
  // blocked without a nonce — the script silently, so the page renders in the
  // wrong theme until hydration. Dropping the forward is the regression this
  // pins; the browser-side proof is e2e/tests/csp-strict.spec.ts.
  it("forwards the request nonce to NextThemesProvider", () => {
    render(
      <ThemeProvider nonce="nonce-abc123">
        <span />
      </ThemeProvider>,
    );

    expect(mockNextThemesProvider).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: "nonce-abc123" }),
    );
  });

  // A page reached outside the proxy's matcher receives no response CSP and
  // therefore has no nonce to pass; next-themes treats undefined as absent.
  it("passes undefined when the request carried no nonce", () => {
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );

    expect(mockNextThemesProvider).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: undefined }),
    );
  });
});
