"use client";

import { useSyncExternalStore } from "react";

type LayoutMode = "master-detail" | "accordion";

// The breakpoint matches Tailwind's `lg` (1024px). Must agree with the CSS
// responsive classes used in the 3-pane layout (INV-C5.3).
const BREAKPOINT_QUERY = "(min-width: 1024px)";

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(BREAKPOINT_QUERY);
  mql.addEventListener("change", callback);
  return () => {
    mql.removeEventListener("change", callback);
  };
}

function getSnapshot(): LayoutMode {
  return window.matchMedia(BREAKPOINT_QUERY).matches ? "master-detail" : "accordion";
}

// INV-C5.5: SSR-safe — server snapshot returns "accordion" so that the server
// render and the first client render agree, avoiding a hydration mismatch.
// The breakpoint-correct value takes effect after mount.
function getServerSnapshot(): LayoutMode {
  return "accordion";
}

/**
 * Returns the current layout mode based on the viewport width.
 * "master-detail" when viewport is ≥1024px; "accordion" otherwise.
 *
 * SSR-safe: returns "accordion" on the server and on the first client render,
 * then updates after mount (INV-C5.5).
 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
