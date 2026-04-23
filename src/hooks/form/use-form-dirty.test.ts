// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFormDirty } from "./use-form-dirty";

describe("useFormDirty", () => {
  it("returns false while initial is null (loading)", () => {
    const { result } = renderHook(() =>
      useFormDirty({ name: "test" }, null),
    );
    expect(result.current).toBe(false);
  });

  it("returns false when current matches initial", () => {
    const initial = { name: "test", active: true };
    const { result } = renderHook(() => useFormDirty(initial, initial));
    expect(result.current).toBe(false);
  });

  it("returns true when current differs from initial", () => {
    const initial = { name: "test", active: true };
    const current = { name: "changed", active: true };
    const { result } = renderHook(() => useFormDirty(current, initial));
    expect(result.current).toBe(true);
  });

  it("returns false when initial is updated to match current (after save)", () => {
    const saved = { name: "saved" };

    const { result, rerender } = renderHook(
      ({ current, initial }: { current: Record<string, unknown>; initial: Record<string, unknown> | null }) =>
        useFormDirty(current, initial),
      { initialProps: { current: saved, initial: { name: "original" } } },
    );
    expect(result.current).toBe(true);

    // Caller updates initial to match current (simulating post-save state sync)
    rerender({ current: saved, initial: saved });
    expect(result.current).toBe(false);
  });

  it("handles Set-like fields converted to sorted arrays", () => {
    const initial = { scopes: ["a", "b", "c"] };
    const same = { scopes: ["a", "b", "c"] };
    const different = { scopes: ["a", "c"] };

    const { result, rerender } = renderHook(
      ({ current }) => useFormDirty(current, initial),
      { initialProps: { current: same } },
    );
    expect(result.current).toBe(false);

    rerender({ current: different });
    expect(result.current).toBe(true);
  });

  it("detects revert to initial as false", () => {
    const initial = { name: "test" };

    const { result, rerender } = renderHook(
      ({ current }) => useFormDirty(current, initial),
      { initialProps: { current: { name: "changed" } } },
    );
    expect(result.current).toBe(true);

    rerender({ current: { name: "test" } });
    expect(result.current).toBe(false);
  });

  it("handles dialog reopen with different initial correctly", () => {
    const { result, rerender } = renderHook(
      ({ current, initial }: { current: Record<string, unknown>; initial: Record<string, unknown> | null }) =>
        useFormDirty(current, initial),
      { initialProps: { current: { name: "A" }, initial: { name: "A" } as Record<string, unknown> | null } },
    );
    expect(result.current).toBe(false);

    // Dialog closes
    rerender({ current: { name: "A" }, initial: null });
    expect(result.current).toBe(false);

    // Dialog reopens with different record
    rerender({ current: { name: "B" }, initial: { name: "B" } });
    expect(result.current).toBe(false);

    // User edits
    rerender({ current: { name: "edited" }, initial: { name: "B" } });
    expect(result.current).toBe(true);
  });
});
