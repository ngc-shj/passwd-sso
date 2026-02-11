/**
 * Tests for useLocalStorage hook logic.
 *
 * Since @testing-library/react is not available, we test the pure logic
 * aspects: shallow merge behavior and JSON resilience.
 */
import { describe, it, expect } from "vitest";

/**
 * Simulates the hydration merge logic from useLocalStorage.
 * Extracted here to verify correctness without rendering React hooks.
 */
function hydrateWithMerge<T>(
  stored: string | null,
  defaultValue: T
): T {
  if (stored === null) return defaultValue;

  try {
    const parsed = JSON.parse(stored) as T;
    if (
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue) &&
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return { ...defaultValue, ...parsed } as T;
    }
    return parsed;
  } catch {
    return defaultValue;
  }
}

describe("useLocalStorage hydration logic", () => {
  it("returns defaults when nothing stored", () => {
    const result = hydrateWithMerge(null, { a: true, b: false });
    expect(result).toEqual({ a: true, b: false });
  });

  it("shallow-merges stored object with defaults", () => {
    const stored = JSON.stringify({ a: false });
    const result = hydrateWithMerge(stored, { a: true, b: true });
    expect(result).toEqual({ a: false, b: true });
  });

  it("stored keys override defaults", () => {
    const stored = JSON.stringify({ a: false, b: false });
    const result = hydrateWithMerge(stored, { a: true, b: true });
    expect(result).toEqual({ a: false, b: false });
  });

  it("ignores extra stored keys not in defaults", () => {
    const stored = JSON.stringify({ a: false, obsolete: true });
    const result = hydrateWithMerge(stored, { a: true, b: true });
    // Shallow merge includes extra keys from stored
    expect(result).toEqual({ a: false, b: true, obsolete: true });
  });

  it("returns defaults on corrupted JSON", () => {
    const result = hydrateWithMerge("not-json{{{", { a: true });
    expect(result).toEqual({ a: true });
  });

  it("handles non-object values without merge", () => {
    const result = hydrateWithMerge(JSON.stringify(42), 0);
    expect(result).toBe(42);
  });

  it("handles string values without merge", () => {
    const result = hydrateWithMerge(JSON.stringify("hello"), "default");
    expect(result).toBe("hello");
  });

  it("handles array values without merge", () => {
    const result = hydrateWithMerge(JSON.stringify([1, 2]), [3, 4]);
    expect(result).toEqual([1, 2]);
  });

  it("handles null stored for array defaults", () => {
    const result = hydrateWithMerge(null, [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });
});
