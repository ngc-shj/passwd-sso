import { useEffect } from "react";

/**
 * Registers a beforeunload handler when `dirty` is true,
 * prompting the browser's native confirmation dialog on page reload or tab close.
 */
export function useBeforeUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
