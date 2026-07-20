import { vi } from "vitest";

/**
 * Installs a jsdom `window.matchMedia` stub so components that call
 * `useLayoutMode` (or otherwise read a media query) can render in tests.
 * jsdom does not implement matchMedia; without this, `useSyncExternalStore`'s
 * client snapshot throws.
 *
 * @param matches - value returned for `.matches` (default false → "accordion"
 *   layout mode). Pass true to simulate the ≥1024px "master-detail" viewport.
 */
export function mockMatchMedia(matches = false): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
