// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { useLocalStorage } from "./use-local-storage";

const KEY = "use-local-storage-test";
// Module-level so the hook's hydration effect sees a stable defaultValue.
const DEFAULTS = { a: true, b: true };
const LIST_DEFAULT = [3, 4];

function strictHook<T>(hook: () => T) {
  return renderHook(hook, { reactStrictMode: true });
}

type SetItemSpy = MockInstance<Storage["setItem"]>;

function writesTo(spy: SetItemSpy, key: string) {
  return spy.mock.calls.filter((call) => call[0] === key);
}

describe("useLocalStorage", () => {
  let setItem: SetItemSpy;

  beforeEach(() => {
    localStorage.clear();
    setItem = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("returns the default and writes nothing when no item is stored", () => {
    const { result } = strictHook(() => useLocalStorage(KEY, DEFAULTS));

    expect(result.current[0]).toEqual({ a: true, b: true });
    expect(writesTo(setItem, KEY)).toHaveLength(0);
  });

  it("hydrates a stored object merged over the defaults without writing it back", () => {
    localStorage.setItem(KEY, JSON.stringify({ a: false, obsolete: 1 }));
    setItem.mockClear();

    const { result } = strictHook(() => useLocalStorage(KEY, DEFAULTS));

    expect(result.current[0]).toEqual({ a: false, b: true, obsolete: 1 });
    expect(writesTo(setItem, KEY)).toHaveLength(0);
  });

  it("writes once, carrying the hydrated value, for a functional update made right after hydration", () => {
    localStorage.setItem(KEY, JSON.stringify({ a: false }));
    setItem.mockClear();

    // The use-sidebar-sections-state ordering: a consumer effect updates the
    // value in the same commit that hydration ran in.
    const { result } = strictHook(() => {
      const [value, setValue] = useLocalStorage(KEY, DEFAULTS);
      useEffect(() => {
        setValue((prev) => ({ ...prev, b: false }));
      }, [setValue]);
      return value;
    });

    expect(result.current).toEqual({ a: false, b: false });
    const writes = writesTo(setItem, KEY);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]))).toEqual({ a: false, b: false });
  });

  it("persists a plain value passed to the setter", () => {
    const { result } = strictHook(() => useLocalStorage(KEY, DEFAULTS));

    act(() => {
      result.current[1]({ a: false, b: false });
    });

    expect(result.current[0]).toEqual({ a: false, b: false });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ a: false, b: false }));
    expect(writesTo(setItem, KEY)).toHaveLength(1);
  });

  it("keeps the defaults when the stored item is not valid JSON", () => {
    localStorage.setItem(KEY, "not-json{{{");

    const { result } = strictHook(() => useLocalStorage(KEY, DEFAULTS));

    expect(result.current[0]).toEqual({ a: true, b: true });
  });

  it("replaces a primitive default with the stored primitive", () => {
    localStorage.setItem(KEY, JSON.stringify("team"));

    const { result } = strictHook(() => useLocalStorage(KEY, "personal"));

    expect(result.current[0]).toBe("team");
  });

  it("replaces an array default with the stored array instead of merging", () => {
    localStorage.setItem(KEY, JSON.stringify([1, 2]));

    const { result } = strictHook(() => useLocalStorage(KEY, LIST_DEFAULT));

    expect(result.current[0]).toEqual([1, 2]);
  });

  it("still updates the value when storage refuses the write", () => {
    setItem.mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { result } = strictHook(() => useLocalStorage(KEY, DEFAULTS));

    act(() => {
      result.current[1]((prev) => ({ ...prev, a: false }));
    });

    expect(result.current[0]).toEqual({ a: false, b: true });
    expect(writesTo(setItem, KEY)).toHaveLength(1);
  });
  describe("an identity update followed by a key change", () => {
    const OTHER_KEY = `${KEY}-other`;

    function renderWithKey() {
      return renderHook(
        ({ storageKey }: { storageKey: string }) => useLocalStorage(storageKey, DEFAULTS),
        { initialProps: { storageKey: KEY }, reactStrictMode: true },
      );
    }

    it("does not write the next key's hydrated value back to it", () => {
      localStorage.setItem(OTHER_KEY, JSON.stringify({ a: false }));
      setItem.mockClear();
      const { result, rerender } = renderWithKey();

      act(() => result.current[1]((prev) => prev));
      rerender({ storageKey: OTHER_KEY });

      expect(result.current[0]).toEqual({ a: false, b: true });
      expect(writesTo(setItem, OTHER_KEY)).toHaveLength(0);
      expect(localStorage.getItem(OTHER_KEY)).toBe(JSON.stringify({ a: false }));
    });

    it("still persists a real update made under the new key", () => {
      localStorage.setItem(OTHER_KEY, JSON.stringify({ a: false }));
      setItem.mockClear();
      const { result, rerender } = renderWithKey();

      act(() => result.current[1]((prev) => prev));
      rerender({ storageKey: OTHER_KEY });
      act(() => result.current[1]((prev) => ({ ...prev, b: false })));

      expect(writesTo(setItem, OTHER_KEY)).toHaveLength(1);
      expect(localStorage.getItem(OTHER_KEY)).toBe(JSON.stringify({ a: false, b: false }));
    });
  });
});
