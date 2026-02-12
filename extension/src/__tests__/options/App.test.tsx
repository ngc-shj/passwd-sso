/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockGetSettings = vi.fn();
const mockSetSettings = vi.fn();
const mockEnsureHostPermission = vi.fn();

vi.mock("../../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
  setSettings: (v: unknown) => mockSetSettings(v),
}));
vi.mock("../../lib/api", () => ({
  ensureHostPermission: (v: unknown) => mockEnsureHostPermission(v),
}));

import { App } from "../../options/App";

describe("Options App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      serverUrl: "https://example.com",
      autoLockMinutes: 15,
    });
    mockEnsureHostPermission.mockResolvedValue(true);
  });

  it("loads settings on mount", async () => {
    render(<App />);
    expect(await screen.findByDisplayValue("https://example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("15")).toBeInTheDocument();
  });

  it("shows error on invalid URL", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/invalid url/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves settings when valid", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.change(screen.getByDisplayValue("15"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockSetSettings).toHaveBeenCalledWith({
        serverUrl: "https://demo.example.com",
        autoLockMinutes: 30,
      });
    });
    expect(await screen.findByText(/saved!/i)).toBeInTheDocument();
  });

  it("shows error when host permission is denied", async () => {
    mockEnsureHostPermission.mockResolvedValue(false);
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/host permission denied/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves when auto-lock is set to Never (0)", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.change(screen.getByDisplayValue("15"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(mockSetSettings).toHaveBeenCalledWith({
        serverUrl: "https://demo.example.com",
        autoLockMinutes: 0,
      });
    });
  });
});
