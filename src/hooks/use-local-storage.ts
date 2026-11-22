"use client";

import { useState, useEffect, useCallback, useRef } from "react";

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
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setStoredValue({ ...defaultValue, ...parsed } as T);
        } else {
          setStoredValue(parsed);
        }
      }
    } catch {
      // Corrupted JSON — keep defaults
    }
  }, [key, defaultValue]);

  // Set by setValue, consumed by the write effect: the updater stays pure (React
  // may run it twice), and a value that only came from hydration is never
  // written back.
  const pendingWriteRef = useRef(false);
  // The value the write effect last saw. StrictMode re-runs mount effects with
  // the value unchanged; without this the re-run would persist the default
  // while a setValue from that same commit is still queued.
  const seenValueRef = useRef(storedValue);

  useEffect(() => {
    if (seenValueRef.current === storedValue) return;
    seenValueRef.current = storedValue;
    if (!pendingWriteRef.current) return;
    pendingWriteRef.current = false;
    try {
      localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Quota exceeded or private browsing — silently degrade
    }
  }, [key, storedValue]);

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    pendingWriteRef.current = true;
    setStoredValue((prev) => (value instanceof Function ? value(prev) : value));
  }, []);

  return [storedValue, setValue];
}
