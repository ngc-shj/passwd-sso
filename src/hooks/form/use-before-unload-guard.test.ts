// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { renderHook } from "@testing-library/react";
import { useBeforeUnloadGuard } from "./use-before-unload-guard";

const { reloadPending } = vi.hoisted(() => ({ reloadPending: { value: false } }));
vi.mock("@/lib/url-helpers", () => ({
  isSessionChangedReloadPending: () => reloadPending.value,
}));

describe("useBeforeUnloadGuard", () => {
  let addSpy: MockInstance<typeof window.addEventListener>;
  let removeSpy: MockInstance<typeof window.removeEventListener>;

  beforeEach(() => {
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    reloadPending.value = false;
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

  // The page's user is gone: its form cannot be saved, and a cancel would
  // strand the page refusing every request.
  it("does not hold fetchApi's session-changed reload", () => {
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true));
    reloadPending.value = true;

    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    unmount();
  });

  it("still holds a reload that is not the session-changed one", () => {
    const { unmount } = renderHook(() => useBeforeUnloadGuard(true));

    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    unmount();
  });
});
