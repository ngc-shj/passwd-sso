/**
 * Locale-parameterized comparator used by scripts/generate-env-example.ts.
 *
 * Extracted into its own module so tests can exercise it directly without
 * triggering the generator's top-level file-write side effects. The generator
 * and its tests share this single comparator implementation (T26 — no local
 * re-implementation in tests).
 */

export function makeEnvKeyCollator(
  locale: string,
): (a: string, b: string) => number {
  const collator = new Intl.Collator(locale, { sensitivity: "variant" });
  return (a, b) => collator.compare(a, b);
}
