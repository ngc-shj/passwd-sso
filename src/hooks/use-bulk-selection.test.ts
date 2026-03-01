// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useBulkSelection,
  type BulkSelectionHandle,
} from "@/hooks/use-bulk-selection";

describe("useBulkSelection", () => {
  it("starts with empty selectedIds", () => {
    const { result } = renderHook(() =>
      useBulkSelection({ entryIds: ["a", "b"], selectionMode: true }),
    );
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });

  it("toggleSelectOne adds and removes ids", () => {
    const { result } = renderHook(() =>
      useBulkSelection({ entryIds: ["a", "b"], selectionMode: true }),
    );

    act(() => result.current.toggleSelectOne("a", true));
    expect(result.current.selectedIds.has("a")).toBe(true);
    expect(result.current.allSelected).toBe(false);

    act(() => result.current.toggleSelectOne("b", true));
    expect(result.current.allSelected).toBe(true);

    act(() => result.current.toggleSelectOne("a", false));
    expect(result.current.selectedIds.has("a")).toBe(false);
    expect(result.current.allSelected).toBe(false);
  });

  it("toggleSelectAll selects and clears all", () => {
    const { result } = renderHook(() =>
      useBulkSelection({ entryIds: ["a", "b", "c"], selectionMode: true }),
    );

    act(() => result.current.toggleSelectAll(true));
    expect(result.current.selectedIds.size).toBe(3);
    expect(result.current.allSelected).toBe(true);

    act(() => result.current.toggleSelectAll(false));
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });

  it("reconciles selectedIds when entryIds change", () => {
    const { result, rerender } = renderHook(
      ({ entryIds }: { entryIds: string[] }) =>
        useBulkSelection({ entryIds, selectionMode: true }),
      { initialProps: { entryIds: ["a", "b", "c"] } },
    );

    act(() => result.current.toggleSelectAll(true));
    expect(result.current.selectedIds.size).toBe(3);

    // Remove "b" from entryIds
    rerender({ entryIds: ["a", "c"] });
    expect(result.current.selectedIds.has("b")).toBe(false);
    expect(result.current.selectedIds.size).toBe(2);
  });

  it("clears selection when selectionMode becomes false", () => {
    const { result, rerender } = renderHook(
      ({ selectionMode }: { selectionMode: boolean }) =>
        useBulkSelection({ entryIds: ["a", "b"], selectionMode }),
      { initialProps: { selectionMode: true } },
    );

    act(() => result.current.toggleSelectAll(true));
    expect(result.current.selectedIds.size).toBe(2);

    rerender({ selectionMode: false });
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("calls onSelectedCountChange with correct (count, allSelected)", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useBulkSelection({
        entryIds: ["a", "b"],
        selectionMode: true,
        onSelectedCountChange: onChange,
      }),
    );

    // Initial: 0 selected
    expect(onChange).toHaveBeenCalledWith(0, false);

    act(() => result.current.toggleSelectOne("a", true));
    expect(onChange).toHaveBeenCalledWith(1, false);

    act(() => result.current.toggleSelectOne("b", true));
    expect(onChange).toHaveBeenCalledWith(2, true);
  });

  it("allSelected is false when entryIds is empty", () => {
    const { result } = renderHook(() =>
      useBulkSelection({ entryIds: [], selectionMode: true }),
    );
    expect(result.current.allSelected).toBe(false);
  });

  it("clearSelection resets selectedIds", () => {
    const { result } = renderHook(() =>
      useBulkSelection({ entryIds: ["a", "b"], selectionMode: true }),
    );

    act(() => result.current.toggleSelectAll(true));
    expect(result.current.selectedIds.size).toBe(2);

    act(() => result.current.clearSelection());
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("exposes toggleSelectAll via selectAllRef", () => {
    const ref = { current: null as BulkSelectionHandle | null };
    const { result } = renderHook(() =>
      useBulkSelection({
        entryIds: ["a", "b", "c"],
        selectionMode: true,
        selectAllRef: ref,
      }),
    );

    expect(ref.current).not.toBeNull();
    expect(typeof ref.current!.toggleSelectAll).toBe("function");

    act(() => ref.current!.toggleSelectAll(true));
    expect(result.current.selectedIds.size).toBe(3);
    expect(result.current.allSelected).toBe(true);

    act(() => ref.current!.toggleSelectAll(false));
    expect(result.current.selectedIds.size).toBe(0);
  });
});
