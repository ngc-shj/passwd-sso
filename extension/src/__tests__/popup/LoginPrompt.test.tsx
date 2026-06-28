/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/storage", () => ({
  getSettings: vi.fn().mockResolvedValue({ serverUrl: "https://vault.example.com" }),
}));

import { LoginPrompt } from "../../popup/components/LoginPrompt";

describe("LoginPrompt", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: { create: vi.fn() },
    });
  });

  it("shows the generic prompt for a manual disconnect", async () => {
    render(<LoginPrompt reason="manual" />);

    expect(
      await screen.findByText(/Allow the connection in passwd-sso/i),
    ).toBeInTheDocument();
    // No re-auth forewarning on a manual disconnect.
    expect(screen.queryByText(/may be asked to re-authenticate/i)).toBeNull();
  });

  it("shows the generic prompt when no reason is recorded", async () => {
    render(<LoginPrompt reason={null} />);

    expect(
      await screen.findByText(/Allow the connection in passwd-sso/i),
    ).toBeInTheDocument();
  });

  it("explains an expired session and forewarns about re-auth", async () => {
    render(<LoginPrompt reason="expired" />);

    expect(await screen.findByText(/session timed out/i)).toBeInTheDocument();
    expect(
      screen.getByText(/may be asked to re-authenticate/i),
    ).toBeInTheDocument();
  });

  it("explains a revoked session", async () => {
    render(<LoginPrompt reason="revoked" />);

    expect(await screen.findByText(/were signed out/i)).toBeInTheDocument();
    expect(
      screen.getByText(/may be asked to re-authenticate/i),
    ).toBeInTheDocument();
  });

  it("maps timeout_logout to the expired framing", async () => {
    render(<LoginPrompt reason="timeout_logout" />);

    expect(await screen.findByText(/session timed out/i)).toBeInTheDocument();
  });

  it("renders the Connect button and server URL", async () => {
    render(<LoginPrompt reason={null} />);

    await waitFor(() => {
      expect(screen.getByText("https://vault.example.com")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});
