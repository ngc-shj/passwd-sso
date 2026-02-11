"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * SSR-safe localStorage hook with shallow merge for object values.
 *
 * - Initializes with `defaultValue` (no hydration mismatch)
 * - Hydrates from localStorage in useEffect (client-only)
 * - For object values: shallow-merges stored with defaults ({...defaults, ...stored})
 *   so new keys added in code are picked up even with old localStorage data
 * - Falls back to defaults on corrupted JSON
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(defaultValue);

  // Hydrate from localStorage on mount (client-only)
  useEffect(() => {
    try {
      const item = localStorage.getItem(key);
      if (item !== null) {
        const parsed = JSON.parse(item) as T;
        // Shallow merge for objects: {...defaults, ...stored}
        if (
          typeof defaultValue === "object" &&
          defaultValue !== null &&
          !Array.isArray(defaultValue) &&
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          setStoredValue({ ...defaultValue, ...parsed } as T);
        } else {
          setStoredValue(parsed);
        }
      }
    } catch {
      // Corrupted JSON — keep defaults
    }
  }, [key, defaultValue]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;
        try {
          localStorage.setItem(key, JSON.stringify(nextValue));
        } catch {
          // Quota exceeded or private browsing — silently degrade
        }
        return nextValue;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}
