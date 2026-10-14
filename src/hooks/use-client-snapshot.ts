"use client";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/**
 * Read a browser-only value that has no change event, without a hydration
 * mismatch: the server render and the hydrating client render see
 * `serverValue`, later renders call `getSnapshot`. Nothing is subscribed, so
 * a change is picked up only when the component re-renders for another reason.
 * `getSnapshot` must return a primitive (or a stable reference).
 */
export function useClientSnapshot<T>(getSnapshot: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribeToNothing, getSnapshot, () => serverValue);
}
