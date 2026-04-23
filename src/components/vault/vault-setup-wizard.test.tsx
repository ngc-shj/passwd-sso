// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockSetup } = vi.hoisted(() => ({
  mockSetup: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ setup: mockSetup }),
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

// Stub UI components to keep rendering lightweight
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ComponentProps<"button">) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...rest }: React.ComponentProps<"div">) => <div {...rest}>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./passphrase-strength", () => ({
  getStrength: () => ({ level: 0, labelKey: null }),
  STRENGTH_COLORS: [] as string[],
}));

vi.mock("@/lib/validations", () => ({
  PASSPHRASE_MIN_LENGTH: 12,
}));

import { VaultSetupWizard } from "./vault-setup-wizard";

// ── Tests ───────────────────────────────────────────────────

describe("VaultSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders info banner with contextMessage when provided", () => {
    const message = "You need to set up your vault to accept the invitation.";

    render(<VaultSetupWizard contextMessage={message} />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("does not render info banner when contextMessage is not provided", () => {
    render(<VaultSetupWizard />);

    // The info banner wraps contextMessage in a <p>; no extra paragraph outside the form
    // The blue info box is only rendered when contextMessage is truthy
    // Verify the setup title is shown but no context message banner
    expect(screen.getByText("setupTitle")).toBeInTheDocument();
    // No element with info banner content
    const allParagraphs = screen.queryAllByRole("paragraph");
    expect(allParagraphs.every(el => !el.closest(".border-blue-500\\/30"))).toBe(true);
  });

  it("does not render info banner when contextMessage is an empty string", () => {
    const { container } = render(<VaultSetupWizard contextMessage="" />);

    // The conditional is `{contextMessage && ...}`, empty string is falsy
    expect(container.querySelector(".border-blue-500\\/30")).toBeNull();
  });

  it("renders the setup form regardless of contextMessage", () => {
    render(<VaultSetupWizard contextMessage="some context" />);

    // Form elements should always be present
    expect(screen.getByLabelText("passphrase")).toBeInTheDocument();
    expect(screen.getByLabelText("confirmPassphrase")).toBeInTheDocument();
    expect(screen.getByText("setupButton")).toBeInTheDocument();
  });
});
