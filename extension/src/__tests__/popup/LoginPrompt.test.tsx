/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { deferred } from "../helpers/deferred";

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

  it("explains the passkey requirement without the re-auth forewarning", async () => {
    render(<LoginPrompt reason="passkey_required" />);

    expect(await screen.findByText(/organization requires a passkey/i)).toBeInTheDocument();
    expect(screen.queryByText(/may be asked to re-authenticate/i)).toBeNull();
  });

  it("opens the web app's passkey page under the configured server URL", async () => {
    storageMocks.getSettings.mockResolvedValueOnce({ serverUrl: "https://vault.example.com/passwd-sso" });
    render(<LoginPrompt reason="passkey_required" />);

    fireEvent.click(await screen.findByRole("button", { name: "Register a passkey" }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "https://vault.example.com/passwd-sso/dashboard/settings/auth/passkey",
    });
  });

  it("control: no passkey button for other disconnect reasons", async () => {
    render(<LoginPrompt reason="revoked" />);

    await screen.findByText("https://vault.example.com");
    expect(screen.queryByRole("button", { name: "Register a passkey" })).toBeNull();
  });

  it("offers no passkey link when the server URL is refused", async () => {
    // A refused URL leaves nothing new on screen, so wait on the settings read
    // itself: the component's handler is attached before this test's await, so
    // it has run once the act settles.
    const settings = deferred<{ serverUrl: string }>();
    storageMocks.getSettings.mockReturnValueOnce(settings.promise);
    render(<LoginPrompt reason="passkey_required" />);
    await act(async () => {
      settings.resolve({ serverUrl: "http://server.example" });
      await settings.promise;
    });
    expect(screen.queryByRole("button", { name: "Register a passkey" })).toBeNull();
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
