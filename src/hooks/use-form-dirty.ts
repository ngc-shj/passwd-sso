/**
 * Track whether a form's current values differ from its initial state.
 * Pure derivation — no refs, no internal state. Follows the same pattern
 * as entry form snapshot comparison (props-driven).
 *
 * @param current  Current form values (must be JSON-serialisable).
 *                 For Set fields, convert to sorted array before passing.
 * @param initial  Initial values from the server, or null while loading.
 * @returns hasChanges — true when current differs from initial.
 */
export function useFormDirty<T extends Record<string, unknown>>(
  current: T,
  initial: T | null,
): boolean {
  if (initial === null) return false;
  return JSON.stringify(current) !== JSON.stringify(initial);
}
