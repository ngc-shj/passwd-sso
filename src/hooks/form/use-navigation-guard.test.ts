// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockPush = vi.fn();

vi.mock("next-intl", () => ({
  useLocale: () => "ja",
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { useNavigationGuard } from "./use-navigation-guard";

function createAnchor(href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  document.body.appendChild(a);
  return a;
}

describe("useNavigationGuard", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not intercept clicks when dirty is false", () => {
    const { result } = renderHook(() => useNavigationGuard(false));

    const anchor = createAnchor("/ja/other-page");
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });
    const preventSpy = vi.spyOn(event, "preventDefault");

    document.dispatchEvent(event);

    expect(preventSpy).not.toHaveBeenCalled();
    expect(result.current.dialogOpen).toBe(false);
  });

  it("intercepts internal link click and opens dialog when dirty is true", () => {
    const { result } = renderHook(() => useNavigationGuard(true));

    const anchor = createAnchor(`${window.location.origin}/ja/passwords`);
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(result.current.dialogOpen).toBe(true);
  });

  it("does not intercept external links", () => {
    const { result } = renderHook(() => useNavigationGuard(true));

    const anchor = createAnchor("https://external.example.com/page");
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(result.current.dialogOpen).toBe(false);
  });

  it("cancelLeave closes dialog and clears pending href", () => {
    const { result } = renderHook(() => useNavigationGuard(true));

    // Open dialog
    const anchor = createAnchor(`${window.location.origin}/ja/passwords`);
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(result.current.dialogOpen).toBe(true);

    // Cancel
    act(() => {
      result.current.cancelLeave();
    });
    expect(result.current.dialogOpen).toBe(false);
  });

  it("confirmLeave calls router.push and closes dialog", () => {
    const { result } = renderHook(() => useNavigationGuard(true));

    // Open dialog
    const anchor = createAnchor(`${window.location.origin}/ja/passwords`);
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });
    act(() => {
      document.dispatchEvent(event);
    });

    // Confirm
    act(() => {
      result.current.confirmLeave();
    });
    expect(result.current.dialogOpen).toBe(false);
    expect(mockPush).toHaveBeenCalledWith("/passwords");
  });

  it("clears dialog when dirty changes to false", () => {
    const { result, rerender } = renderHook(
      ({ dirty }) => useNavigationGuard(dirty),
      { initialProps: { dirty: true } },
    );

    // Open dialog
    const anchor = createAnchor(`${window.location.origin}/ja/passwords`);
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(result.current.dialogOpen).toBe(true);

    // dirty becomes false
    rerender({ dirty: false });
    expect(result.current.dialogOpen).toBe(false);
  });

  it("removes click listener on unmount", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useNavigationGuard(true));

    removeSpy.mockClear();
    unmount();

    const clickCalls = removeSpy.mock.calls.filter(([type]) => type === "click");
    expect(clickCalls.length).toBeGreaterThanOrEqual(1);
    removeSpy.mockRestore();
  });
});
