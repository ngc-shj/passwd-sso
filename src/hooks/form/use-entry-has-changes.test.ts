// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEntryHasChanges } from "@/hooks/form/use-entry-has-changes";

describe("useEntryHasChanges", () => {
  it("returns false on first render (baseline equals current)", () => {
    const { result } = renderHook(() =>
      useEntryHasChanges(() => ({ title: "alpha", notes: "" }), ["alpha", ""]),
    );
    expect(result.current).toBe(false);
  });

  it("returns true when a field differs from the captured baseline", () => {
    let title = "alpha";
    const { result, rerender } = renderHook(() =>
      useEntryHasChanges(() => ({ title, notes: "" }), [title]),
    );

    expect(result.current).toBe(false);

    title = "beta";
    rerender();

    expect(result.current).toBe(true);
  });

  it("returns true for a nested field change", () => {
    let folder = { id: "f1", name: "old" };
    const { result, rerender } = renderHook(() =>
      useEntryHasChanges(() => ({ folder }), [folder]),
    );

    expect(result.current).toBe(false);

    folder = { id: "f1", name: "new" };
    rerender();

    expect(result.current).toBe(true);
  });

  it("returns true when array order changes (JSON.stringify is order-sensitive)", () => {
    let tags = ["a", "b"];
    const { result, rerender } = renderHook(() =>
      useEntryHasChanges(() => ({ tags }), [tags]),
    );

    expect(result.current).toBe(false);

    tags = ["b", "a"];
    rerender();

    expect(result.current).toBe(true);
  });

  it("returns false when state is reverted back to the baseline value", () => {
    let title = "alpha";
    const { result, rerender } = renderHook(() =>
      useEntryHasChanges(() => ({ title }), [title]),
    );

    title = "beta";
    rerender();
    expect(result.current).toBe(true);

    title = "alpha";
    rerender();
    expect(result.current).toBe(false);
  });

  it("captures the baseline only once (initial render's value, not the latest)", () => {
    let title = "alpha";
    const { result, rerender } = renderHook(() =>
      useEntryHasChanges(() => ({ title }), [title]),
    );

    title = "beta";
    rerender();
    expect(result.current).toBe(true);

    // Even though we now repeat the new value, baseline is still "alpha".
    title = "beta";
    rerender();
    expect(result.current).toBe(true);
  });
});
