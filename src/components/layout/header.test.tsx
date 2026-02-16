// @vitest-environment jsdom
/**
 * Header — Client Component test (jsdom)
 *
 * Covers:
 *   - APP_NAME is displayed in the header
 *   - Vault UNLOCKED → shows Recovery Key / Change Passphrase / Lock menu items
 *   - Vault not UNLOCKED → hides vault-specific menu items
 *   - User name/email are displayed
 */

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUseSession, mockUseVault, mockLock } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockUseVault: vi.fn(),
  mockLock: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: mockUseVault,
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
vi.mock("@/components/vault/change-passphrase-dialog", () => ({
  ChangePassphraseDialog: () => null,
}));
vi.mock("@/components/vault/recovery-key-dialog", () => ({
  RecoveryKeyDialog: () => null,
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
import { VAULT_STATUS } from "@/lib/constants";

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
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOCKED,
      lock: mockLock,
    });
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

  it("shows vault menu items when vault is UNLOCKED", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.UNLOCKED,
      lock: mockLock,
    });

    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.getByText("changePassphrase")).toBeInTheDocument();
    expect(screen.getByText("recoveryKey")).toBeInTheDocument();
    expect(screen.getByText("lockVault")).toBeInTheDocument();
  });

  it("hides vault menu items when vault is LOCKED", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOCKED,
      lock: mockLock,
    });

    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.queryByText("changePassphrase")).not.toBeInTheDocument();
    expect(screen.queryByText("recoveryKey")).not.toBeInTheDocument();
    expect(screen.queryByText("lockVault")).not.toBeInTheDocument();
  });

  it("hides vault menu items when vault is SETUP_REQUIRED", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.SETUP_REQUIRED,
      lock: mockLock,
    });

    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.queryByText("changePassphrase")).not.toBeInTheDocument();
    expect(screen.queryByText("recoveryKey")).not.toBeInTheDocument();
    expect(screen.queryByText("lockVault")).not.toBeInTheDocument();
  });

  it("always shows sign out button regardless of vault status", () => {
    render(<Header onMenuToggle={onMenuToggle} />);

    expect(screen.getByText("signOut")).toBeInTheDocument();
  });
});
