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
  // Declared above the hydration effect, which clears it; see the write effect.
  const pendingWriteRef = useRef<string | null>(null);

  // Hydrate from localStorage on mount (client-only)
  useEffect(() => {
    // A write still pending for another key would otherwise survive the
    // switch (the value need not change, so the write effect never consumes
    // it) and persist that key's hydrated value on an A→B→A return.
    if (pendingWriteRef.current !== key) pendingWriteRef.current = null;
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

  // Set by setValue to the key it was called for, consumed by the write effect:
  // the updater stays pure (React may run it twice), and a value that only came
  // from hydration is never written back. Holding the key, not a boolean, keeps
  // an identity update (`prev => prev`, which changes nothing and so never runs
  // the write effect) from leaving a flag that would persist the next key's
  // hydrated value.
  // The value the write effect last saw. StrictMode re-runs mount effects with
  // the value unchanged; without this the re-run would persist the default
  // while a setValue from that same commit is still queued.
  const seenValueRef = useRef(storedValue);

  useEffect(() => {
    if (seenValueRef.current === storedValue) return;
    seenValueRef.current = storedValue;
    const pendingKey = pendingWriteRef.current;
    pendingWriteRef.current = null;
    if (pendingKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Quota exceeded or private browsing — silently degrade
    }
  }, [key, storedValue]);

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    pendingWriteRef.current = key;
    setStoredValue((prev) => (value instanceof Function ? value(prev) : value));
  }, [key]);

  return [storedValue, setValue];
}
