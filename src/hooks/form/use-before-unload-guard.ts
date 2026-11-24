import { useEffect } from "react";
import { isSessionChangedReloadPending } from "@/lib/url-helpers";

/**
 * Registers a beforeunload handler when `dirty` is true,
 * prompting the browser's native confirmation dialog on page reload or tab close.
 *
 * Stands down for fetchApi's session-changed reload: the page's user is no
 * longer signed in, so its form could not be saved, and a cancel would leave
 * the page refusing every request.
 */
export function useBeforeUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (isSessionChangedReloadPending()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
