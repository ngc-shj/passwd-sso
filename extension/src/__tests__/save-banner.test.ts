/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Override navigator.language for consistent i18n
Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });

// Mock shadow-host
const mockRoot = document.createElement("div");
vi.mock("../content/ui/shadow-host", () => ({
  getShadowHost: vi.fn(() => ({ host: document.createElement("div"), root: mockRoot })),
  removeShadowHost: vi.fn(),
}));

import { showSaveBanner, hideSaveBanner } from "../content/ui/save-banner";

describe("save-banner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRoot.innerHTML = "";
  });

  afterEach(() => {
    hideSaveBanner();
    vi.useRealTimers();
  });

  it("shows save banner with correct text", () => {
    const onSave = vi.fn();
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();

    showSaveBanner({
      host: "example.com",
      username: "alice",
      action: "save",
      onSave,
      onUpdate,
      onDismiss,
    });

    const banner = mockRoot.querySelector("#psso-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("example.com");
    expect(banner!.textContent).toContain("alice");
  });

  it("shows update banner with existing title", () => {
    showSaveBanner({
      host: "github.com",
      username: "alice",
      action: "update",
      existingTitle: "GitHub",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: vi.fn(),
    });

    const banner = mockRoot.querySelector("#psso-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("GitHub");
  });

  it("calls onSave when save button clicked and hides banner", () => {
    const onSave = vi.fn();
    showSaveBanner({
      host: "example.com",
      username: "alice",
      action: "save",
      onSave,
      onUpdate: vi.fn(),
      onDismiss: vi.fn(),
    });

    const saveBtn = mockRoot.querySelector(".psso-btn-primary") as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    saveBtn.click();
    expect(onSave).toHaveBeenCalledTimes(1);
    // Banner should be hidden after save
    expect(mockRoot.querySelector("#psso-save-banner")).toBeNull();
  });

  it("calls onUpdate when update button clicked and hides banner", () => {
    const onUpdate = vi.fn();
    showSaveBanner({
      host: "github.com",
      username: "alice",
      action: "update",
      existingTitle: "GitHub",
      onSave: vi.fn(),
      onUpdate,
      onDismiss: vi.fn(),
    });

    const updateBtn = mockRoot.querySelector(".psso-btn-primary") as HTMLButtonElement;
    expect(updateBtn).toBeTruthy();
    updateBtn.click();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Banner should be hidden after update
    expect(mockRoot.querySelector("#psso-save-banner")).toBeNull();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = vi.fn();
    showSaveBanner({
      host: "example.com",
      username: "alice",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss,
    });

    const dismissBtn = mockRoot.querySelector(".psso-btn-secondary") as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();
    dismissBtn.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses after 15 seconds", () => {
    const onDismiss = vi.fn();
    showSaveBanner({
      host: "example.com",
      username: "alice",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss,
    });

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("removes banner on hideSaveBanner", () => {
    showSaveBanner({
      host: "example.com",
      username: "alice",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(mockRoot.querySelector("#psso-save-banner")).toBeTruthy();
    hideSaveBanner();
    expect(mockRoot.querySelector("#psso-save-banner")).toBeNull();
  });

  it("clears first auto-dismiss timer when called twice in succession", () => {
    const onDismiss1 = vi.fn();
    const onDismiss2 = vi.fn();

    showSaveBanner({
      host: "first.com",
      username: "user1",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: onDismiss1,
    });

    // Advance 10 seconds (not yet dismissed)
    vi.advanceTimersByTime(10_000);
    expect(onDismiss1).not.toHaveBeenCalled();

    // Replace with second banner
    showSaveBanner({
      host: "second.com",
      username: "user2",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: onDismiss2,
    });

    // Advance another 5 seconds — first timer would have fired at 15s total,
    // but it should have been cleared when second banner replaced it
    vi.advanceTimersByTime(5_000);
    expect(onDismiss1).not.toHaveBeenCalled();
    expect(onDismiss2).not.toHaveBeenCalled();

    // Advance to 15 seconds from second banner creation — second timer fires
    vi.advanceTimersByTime(10_000);
    expect(onDismiss1).not.toHaveBeenCalled();
    expect(onDismiss2).toHaveBeenCalledTimes(1);
  });

  it("replaces existing banner when called twice", () => {
    showSaveBanner({
      host: "first.com",
      username: "user1",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: vi.fn(),
    });

    showSaveBanner({
      host: "second.com",
      username: "user2",
      action: "save",
      onSave: vi.fn(),
      onUpdate: vi.fn(),
      onDismiss: vi.fn(),
    });

    const banners = mockRoot.querySelectorAll("#psso-save-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toContain("second.com");
  });
});
