// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSignIn, mockUseCallbackUrl } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockUseCallbackUrl: vi.fn(() => "/dashboard"),
}));

vi.mock("next-auth/react", () => ({
  signIn: mockSignIn,
}));

vi.mock("@/hooks/use-callback-url", () => ({
  useCallbackUrl: () => mockUseCallbackUrl(),
}));

import { SignInButton } from "./signin-button";

describe("SignInButton", () => {
  it("renders provider label and icon", () => {
    render(
      <SignInButton
        provider="google"
        label="Sign in with Google"
        icon={<span data-testid="provider-icon" />}
      />,
    );
    expect(screen.getByRole("button", { name: /Sign in with Google/ })).toBeInTheDocument();
    expect(screen.getByTestId("provider-icon")).toBeInTheDocument();
  });

  it("invokes signIn with the provider and the callbackUrl from useCallbackUrl on click", async () => {
    mockSignIn.mockResolvedValueOnce(undefined);
    mockUseCallbackUrl.mockReturnValueOnce("/dashboard?ext=1");
    render(<SignInButton provider="github" label="GitHub" icon={null} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith("github", { callbackUrl: "/dashboard?ext=1" });
    });
  });

  it("disables the button after click while signIn is pending (R26 disabled cue)", async () => {
    let resolveSignIn: (() => void) | undefined;
    mockSignIn.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSignIn = resolve;
    }));
    render(<SignInButton provider="google" label="Google" icon={null} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    resolveSignIn?.();
  });
});
