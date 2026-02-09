import { vi } from "vitest";

const MODEL_METHODS = [
  "findUnique",
  "findFirst",
  "findMany",
  "create",
  "update",
  "delete",
  "deleteMany",
  "count",
  "upsert",
] as const;

/**
 * Creates a deeply proxied mock where any model property access returns
 * an object whose methods are all vi.fn().
 *
 * Usage:
 *   const mockPrisma = createMockPrisma();
 *   mockPrisma.user.findUnique.mockResolvedValue({ id: "1" });
 */
export function createMockPrisma() {
  const modelCache = new Map<
    string,
    Record<string, ReturnType<typeof vi.fn>>
  >();

  const handler: ProxyHandler<object> = {
    get(_target, prop: string) {
      if (prop === "$transaction") {
        return vi.fn(async (fn: unknown) => {
          if (typeof fn === "function") {
            // Interactive transaction: pass the proxy itself as the tx client
            return fn(proxy);
          }
          // Batch transaction: array of promises
          return Promise.all(fn as Promise<unknown>[]);
        });
      }

      if (prop === "then" || prop === "catch" || prop === "finally") {
        return undefined;
      }

      if (!modelCache.has(prop)) {
        const methods: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const method of MODEL_METHODS) {
          methods[method] = vi.fn().mockResolvedValue(undefined);
        }
        modelCache.set(prop, methods);
      }
      return modelCache.get(prop);
    },
  };

  const proxy = new Proxy({}, handler);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return proxy as any;
}
