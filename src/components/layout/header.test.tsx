// @vitest-environment jsdom
/**
 * Header — Client Component test (jsdom)
 *
 * Covers:
 *   - APP_NAME is displayed in the header
 *   - LockVaultButton is rendered
 *   - Personal settings link appears in the dropdown
 *   - User name/email are displayed
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

// Mock heavy child components to simplify rendering
vi.mock("@/components/auth/user-avatar", () => ({
  UserAvatar: () => <div data-testid="user-avatar" />,
}));
vi.mock("@/components/auth/signout-button", () => ({
  SignOutButton: React.forwardRef<HTMLButtonElement>(function SignOutButton(props, ref) {
    return <button ref={ref} {...props}>signOut</button>;
  }),
}));
vi.mock("./language-switcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));
vi.mock("@/components/layout/lock-vault-button", () => ({
  LockVaultButton: () => <button data-testid="lock-vault-button">lockVault</button>,
}));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));
vi.mock("./theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false, loading: false, enable: vi.fn(), disable: vi.fn() }),
}));

vi.mock("@/lib/vault/active-vault-context", () => ({
  useActiveVault: () => null,
}));

// Mock dropdown to render content directly (bypass Radix interaction)
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  DropdownMenuTrigger: ({ children, asChild, ...rest }: { children: React.ReactNode; asChild?: boolean }) => <div {...rest}>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  DropdownMenuItem: ({ children, disabled, onClick, asChild, ...rest }: React.ComponentProps<"div"> & { disabled?: boolean; asChild?: boolean }) => (
    <div role="menuitem" data-disabled={disabled || undefined} onClick={onClick} {...rest}>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { Header } from "./header";

// ── Helpers ────────────────────────────────────────────────
const defaultSession = {
  data: {
    user: { id: "u1", name: "Test User", email: "test@example.com" },
    expires: "2099-01-01",
  },
  status: "authenticated" as const,
  update: vi.fn(),
};

describe("Header", () => {
  const onMenuToggle = vi.fn();

  beforeEach(() => {
    mockUseSession.mockReturnValue(defaultSession);
  });

  it("displays APP_NAME", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    // APP_NAME defaults to "passwd-sso"
    expect(screen.getByText("passwd-sso")).toBeInTheDocument();
  });

  it("displays user name and email", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
  });

  it("renders LockVaultButton", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.getByTestId("lock-vault-button")).toBeInTheDocument();
  });

  it("shows personal settings link in the dropdown", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    // tDash("settings") returns "settings" via the mock translator
    expect(screen.getByText("settings")).toBeInTheDocument();
  });

  it("always shows sign out button regardless of vault status", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.getByText("signOut")).toBeInTheDocument();
  });

  it("hides extension install link when NEXT_PUBLIC_CHROME_STORE_URL is not set", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.queryByText("installExtension")).not.toBeInTheDocument();
  });
});
