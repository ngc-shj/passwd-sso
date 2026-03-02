/**
 * Creates a mock translator function that satisfies the next-intl Translator type.
 * The function returns the key as-is (identity), and stubs `rich`, `markup`, `raw`, `has`.
 */
export function mockTranslator<T = unknown>(fn?: (key: string, values?: Record<string, unknown>) => string): T {
  const t = fn ?? ((key: string) => key);
  const mock = Object.assign(t, {
    rich: (key: string) => key,
    markup: (key: string) => key,
    raw: (key: string) => key,
    has: () => true,
  });
  return mock as unknown as T;
}
