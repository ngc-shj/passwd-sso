// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockSetup, mockGetStrength } = vi.hoisted(() => ({
  mockSetup: vi.fn(),
  mockGetStrength: vi.fn(),
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
  getStrength: mockGetStrength,
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
    mockGetStrength.mockReturnValue({ level: 0, labelKey: null });
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

const VALID_PASSPHRASE = "correct horse battery";

function typeInto(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("VaultSetupWizard form behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStrength.mockReturnValue({ level: 0, labelKey: null });
  });

  it("shows the min-length hint while the passphrase is shorter than the minimum", () => {
    render(<VaultSetupWizard />);
    typeInto("passphrase", "short");

    expect(screen.getByText("passphraseMinLength")).toBeInTheDocument();
  });

  it("hides the min-length hint once the passphrase reaches the minimum", () => {
    render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);

    expect(screen.queryByText("passphraseMinLength")).toBeNull();
  });

  it("shows the strength label returned for the typed passphrase", () => {
    mockGetStrength.mockReturnValue({ level: 3, labelKey: "strengthStrong" });
    render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);

    expect(mockGetStrength).toHaveBeenLastCalledWith(VALID_PASSPHRASE);
    expect(screen.getByText("strengthStrong")).toBeInTheDocument();
  });

  it("shows the mismatch hint when the confirmation differs", () => {
    render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);
    typeInto("confirmPassphrase", `${VALID_PASSPHRASE}x`);

    expect(screen.getByText("passphraseMismatch")).toBeInTheDocument();
    expect(screen.getByText("setupButton")).toBeDisabled();
  });

  it("keeps submit disabled for a matching passphrase below the minimum length", () => {
    render(<VaultSetupWizard />);
    typeInto("passphrase", "short");
    typeInto("confirmPassphrase", "short");

    expect(screen.getByText("setupButton")).toBeDisabled();
  });

  it("calls setup with the passphrase when a valid matching pair is submitted", async () => {
    mockSetup.mockResolvedValue(undefined);
    render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);
    typeInto("confirmPassphrase", VALID_PASSPHRASE);

    fireEvent.click(screen.getByText("setupButton"));

    await waitFor(() => expect(mockSetup).toHaveBeenCalledWith(VALID_PASSPHRASE));
    expect(screen.queryByText("setupError")).toBeNull();
  });

  it("does not call setup when the form is submitted with an invalid pair", () => {
    const { container } = render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);
    typeInto("confirmPassphrase", "different passphrase");

    const form = container.querySelector("form");
    if (!form) throw new Error("form not rendered");
    fireEvent.submit(form);

    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("shows the setup error when setup rejects", async () => {
    mockSetup.mockRejectedValue(new Error("boom"));
    render(<VaultSetupWizard />);
    typeInto("passphrase", VALID_PASSPHRASE);
    typeInto("confirmPassphrase", VALID_PASSPHRASE);

    fireEvent.click(screen.getByText("setupButton"));

    expect(await screen.findByText("setupError")).toBeInTheDocument();
    expect(screen.getByText("setupButton")).not.toBeDisabled();
  });

  it("toggles the passphrase input between hidden and visible", () => {
    render(<VaultSetupWizard />);
    const input = screen.getByLabelText("passphrase");
    expect(input).toHaveAttribute("type", "password");

    const toggle = input.parentElement?.querySelector("button");
    if (!toggle) throw new Error("toggle not rendered");
    fireEvent.click(toggle);

    expect(input).toHaveAttribute("type", "text");
  });
});
