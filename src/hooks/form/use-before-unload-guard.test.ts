// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBeforeUnloadGuard } from "./use-before-unload-guard";

describe("useBeforeUnloadGuard", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("does not add beforeunload listener when dirty is false", () => {
    renderHook(() => useBeforeUnloadGuard(false));
    const beforeunloadCalls = addSpy.mock.calls.filter(
      ([type]) => type === "beforeunload"
    );
    expect(beforeunloadCalls).toHaveLength(0);
  });

  it("adds beforeunload listener when dirty is true", () => {
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true));
    const beforeunloadCalls = addSpy.mock.calls.filter(
      ([type]) => type === "beforeunload"
    );
    expect(beforeunloadCalls).toHaveLength(1);
    unmount();
  });

  it("removes listener when dirty changes true -> false", () => {
    const { rerender, unmount } = renderHook(
      ({ dirty }) => useBeforeUnloadGuard(dirty),
      { initialProps: { dirty: true } }
    );

    removeSpy.mockClear();
    rerender({ dirty: false });

    const removeCalls = removeSpy.mock.calls.filter(
      ([type]) => type === "beforeunload"
    );
    expect(removeCalls).toHaveLength(1);
    unmount();
  });

  it("removes listener on unmount while dirty", () => {
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true));

    removeSpy.mockClear();
    unmount();

    const removeCalls = removeSpy.mock.calls.filter(
      ([type]) => type === "beforeunload"
    );
    expect(removeCalls).toHaveLength(1);
  });

  it("handler calls preventDefault on beforeunload event", () => {
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true));

    const event = new Event("beforeunload") as BeforeUnloadEvent;
    const preventSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);

    expect(preventSpy).toHaveBeenCalled();
    unmount();
  });
});
