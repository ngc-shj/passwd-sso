// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSignOut } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  withBasePath: (p: string) => `/base${p}`,
}));

import { SignOutButton } from "./signout-button";

describe("SignOutButton", () => {
  it("renders the signOut translation key as the button label", () => {
    render(<SignOutButton />);
    expect(screen.getByRole("button", { name: /signOut/ })).toBeInTheDocument();
  });

  it("invokes signOut with the basePath-prefixed sign-in URL on click", () => {
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/base/auth/signin" });
  });
});
