import { vi } from "vitest";

export interface ClipboardStub {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
}

/**
 * Install a `navigator.clipboard` stub for a test.
 *
 * `configurable: true` matters: the UNAVAILABLE path needs the property to be
 * removable again, and teardown must be able to delete it so a test that
 * installs one cannot leak it into the next.
 */
export function installClipboard(
  overrides: Partial<Record<keyof ClipboardStub, unknown>> = {},
): ClipboardStub {
  const stub = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
    ...overrides,
  };
  Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
  return stub as ClipboardStub;
}

/** Release the stub. Register at acquisition so a failing assertion cannot leak it. */
export function uninstallClipboard(): void {
  Reflect.deleteProperty(navigator, "clipboard");
}
