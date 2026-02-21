// Content script entry point for form detection + inline autofill.
// Declared in manifest content_scripts → CRXJS bundles via Vite.
// TypeScript and imports work here (unlike web_accessible_resources files).

import { initFormDetector } from "./form-detector-lib";
import { initLoginDetector } from "./login-detector-lib";

// Guard against double-injection per frame: manifest content_scripts may already be
// attached, but programmatic executeScript (from popup after permission grant)
// can inject a second instance.
const GUARD_KEY = "__passwdSsoFormDetector";
if (!(window as unknown as Record<string, boolean>)[GUARD_KEY]) {
  (window as unknown as Record<string, boolean>)[GUARD_KEY] = true;

  const { destroy } = initFormDetector();
  const { destroy: destroyLoginDetector } = initLoginDetector();

  // Self-destruct when extension context is invalidated (extension reload/update).
  // Orphaned content scripts can no longer communicate with the service worker,
  // so clean up all listeners and DOM to stop errors.
  window.addEventListener("error", (event) => {
    if (event.message?.includes("Extension context invalidated")) {
      event.preventDefault();
      destroy();
      destroyLoginDetector();
    }
  });
}
