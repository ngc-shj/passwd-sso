// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockHardNavigate, mockSignOut } = vi.hoisted(() => ({
  mockHardNavigate: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock("@/lib/url-helpers", () => ({
  currentAppPath: () => "/en/admin/tenant/members",
  hardNavigate: mockHardNavigate,
  withBasePath: (p: string) => p,
}));

import { SessionStateUnavailable } from "./session-state-unavailable";

describe("SessionStateUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains the outage without mentioning a passkey requirement", () => {
    render(<SessionStateUnavailable />);

    expect(
      screen.getByRole("heading", { name: "Auth.sessionStateUnavailableTitle" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Auth.sessionStateUnavailableDescription")).toBeInTheDocument();
    expect(screen.queryByText(/passkeyRequired/)).not.toBeInTheDocument();
  });

  it("retries by reloading the current path in place", () => {
    render(<SessionStateUnavailable />);

    fireEvent.click(screen.getByRole("button", { name: "Common.tryAgain" }));
    expect(mockHardNavigate).toHaveBeenCalledWith("/en/admin/tenant/members");
  });

  it("offers sign-out", () => {
    render(<SessionStateUnavailable />);

    fireEvent.click(screen.getByRole("button", { name: /signOut/ }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
