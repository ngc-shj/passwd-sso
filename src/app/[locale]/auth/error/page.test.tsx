// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
vi.mock("next-intl/server", () => ({
  getTranslations: () => (key: string) => key,
  setRequestLocale: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>{children}</div>
  ),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card-content" className={className}>{children}</div>
  ),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card-header" className={className}>{children}</div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h2 data-testid="card-title" className={className}>{children}</h2>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="button" data-as-child={asChild}>{children}</div>
  ),
}));

import AuthErrorPage from "./page";

// ── Tests ────────────────────────────────────────────────────

describe("AuthErrorPage", () => {
  async function renderPage(error?: string) {
    const Component = await AuthErrorPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve(error ? { error } : {}),
    });
    return render(Component);
  }

  it("renders Verification error with specific title", async () => {
    await renderPage("Verification");

    expect(screen.getByText("errorVerification")).toBeInTheDocument();
    expect(screen.getByText("errorVerificationDescription")).toBeInTheDocument();
  });

  it("renders AccessDenied error with specific title", async () => {
    await renderPage("AccessDenied");

    expect(screen.getByText("errorAccessDenied")).toBeInTheDocument();
    expect(screen.getByText("errorAccessDeniedDescription")).toBeInTheDocument();
  });

  it("renders generic error for unknown error code", async () => {
    await renderPage("SomethingUnknown");

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("errorDescription")).toBeInTheDocument();
  });

  it("renders generic error when no error param provided", async () => {
    await renderPage();

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("errorDescription")).toBeInTheDocument();
  });

  it("renders try-again link pointing to signin", async () => {
    await renderPage("Verification");

    const link = screen.getByText("tryAgain");
    expect(link.closest("a")).toHaveAttribute("href", "/auth/signin");
  });
});
