/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const storageMocks = vi.hoisted(() => ({
  getSettings: vi.fn().mockResolvedValue({ serverUrl: "https://vault.example.com" }),
}));
vi.mock("../../lib/storage", () => storageMocks);

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

  it("treats a plain-http non-loopback server URL as no server: nothing shown, nothing opened", async () => {
    storageMocks.getSettings.mockResolvedValueOnce({ serverUrl: "http://server.example" });
    render(<LoginPrompt reason={null} />);
    await waitFor(() => expect(storageMocks.getSettings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("http://server.example")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it.each(["https://vault.example.com", "http://localhost:3000"])("control: %s is shown and opened", async (url) => {
    storageMocks.getSettings.mockResolvedValueOnce({ serverUrl: url });
    render(<LoginPrompt reason={null} />);
    expect(await screen.findByText(url)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${url}/dashboard?ext_connect=1` });
  });
});
