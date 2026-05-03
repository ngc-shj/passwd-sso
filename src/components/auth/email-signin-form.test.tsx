// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSignIn, mockUseCallbackUrl } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockUseCallbackUrl: vi.fn(() => "/dashboard"),
}));

vi.mock("next-auth/react", () => ({
  signIn: mockSignIn,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-callback-url", () => ({
  useCallbackUrl: () => mockUseCallbackUrl(),
}));

import { EmailSignInForm } from "./email-signin-form";

const SENTINEL_NOT_A_SECRET_ZJYK = "ZJYKZJYKZJYK_not_a_secret";

describe("EmailSignInForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the email input and submit button (R26 disabled cue: button enabled by default)", () => {
    render(<EmailSignInForm />);
    expect(screen.getByPlaceholderText("emailPlaceholder")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: /signInWithEmail/ });
    expect(submit).not.toBeDisabled();
  });

  it("shows an inline error and does NOT call signIn for invalid input", async () => {
    const { container } = render(<EmailSignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: "not-an-email" },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByText("emailInvalid")).toBeInTheDocument());
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("submits trimmed email to nodemailer with redirect:false (anti-enumeration design)", async () => {
    mockSignIn.mockResolvedValueOnce(undefined);
    const { container } = render(<EmailSignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: "  user@example.com  " },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith("nodemailer", {
        email: "user@example.com",
        callbackUrl: "/dashboard",
        redirect: false,
      });
    });
  });

  it("renders the success state once signIn resolves (always-success anti-enumeration)", async () => {
    mockSignIn.mockResolvedValueOnce(undefined);
    const { container } = render(<EmailSignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: "user@example.com" },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByText("emailSent")).toBeInTheDocument());
  });

  it("disables the submit button while signIn is pending (R26 disabled cue)", async () => {
    let resolveSignIn: (() => void) | undefined;
    mockSignIn.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSignIn = resolve; }),
    );
    const { container } = render(<EmailSignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: "user@example.com" },
    });
    const btn = screen.getByRole("button", { name: /signInWithEmail/ });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(btn).toBeDisabled());
    resolveSignIn?.();
  });

  it("§Sec-2: never echoes the user-entered email sentinel into the error DOM", async () => {
    // Type the sentinel as the email (it is invalid → triggers emailInvalid path).
    // The displayed error must come from the i18n key, never the raw input.
    const { container } = render(<EmailSignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByText("emailInvalid")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK))).toBeNull();
  });

  it("§Sec-2: sentinel must not surface when signIn throws (catch-path renders generic error key only)", async () => {
    mockSignIn.mockRejectedValueOnce(new Error("network"));
    const { container } = render(<EmailSignInForm />);
    // Use an email-shaped sentinel so the regex passes; the throw triggers catch.
    const emailSentinel = `${SENTINEL_NOT_A_SECRET_ZJYK}@example.com`;
    fireEvent.change(screen.getByPlaceholderText("emailPlaceholder"), {
      target: { value: emailSentinel },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK))).toBeNull();
  });
});
