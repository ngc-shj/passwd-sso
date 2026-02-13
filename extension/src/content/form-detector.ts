// Content script entry point for form detection + inline autofill.
// Declared in manifest content_scripts → CRXJS bundles via Vite.
// TypeScript and imports work here (unlike web_accessible_resources files).

import { initFormDetector } from "./form-detector-lib";

// iframe guard — only run in top-level frames
if (window === window.top) {
  const { destroy } = initFormDetector();

  // Self-destruct when extension context is invalidated (extension reload/update).
  // Orphaned content scripts can no longer communicate with the service worker,
  // so clean up all listeners and DOM to stop errors.
  window.addEventListener("error", (event) => {
    if (event.message?.includes("Extension context invalidated")) {
      event.preventDefault();
      destroy();
    }
  });
}
