// Content script entry point for form detection + inline autofill.
// Declared in manifest content_scripts → CRXJS bundles via Vite.
// TypeScript and imports work here (unlike web_accessible_resources files).

import { initFormDetector } from "./form-detector-lib";
import { initLoginDetector } from "./login-detector-lib";
import { initCreditCardDetector } from "./cc-form-detector-lib";
import { initIdentityDetector } from "./identity-form-detector-lib";
import { removeShadowHost } from "./ui/shadow-host";
// Register AUTOFILL_FILL listener so autofill works without chrome.scripting.executeScript
// (which requires host permissions or activeTab that may not be available).
import "./autofill-lib";
// Register AUTOFILL_CC_FILL / AUTOFILL_IDENTITY_FILL listeners for the same reason.
import "./autofill-cc-lib";
import "./autofill-identity-lib";
// Register WebAuthn bridge for passkey provider (MAIN world ↔ ISOLATED world)
import "./webauthn-bridge";

// Guard against double-injection per frame: manifest content_scripts may already be
// attached, but programmatic executeScript (from popup after permission grant)
// can inject a second instance.
const GUARD_KEY = "__passwdSsoFormDetector";
if (!(window as unknown as Record<string, boolean>)[GUARD_KEY]) {
  (window as unknown as Record<string, boolean>)[GUARD_KEY] = true;

  // Collect every detector's teardown. Each detector only removes its own
  // listeners + hides the dropdown; the shared shadow host is removed once here.
  const cleanups = [
    initFormDetector(),
    initLoginDetector(),
    initCreditCardDetector(),
    initIdentityDetector(),
  ];

  // Self-destruct when extension context is invalidated (extension reload/update).
  // Orphaned content scripts can no longer communicate with the service worker,
  // so clean up all listeners and DOM to stop errors.
  // The error message varies: "Extension context invalidated" (direct API call)
  // or "Cannot read properties of undefined" (chrome.runtime becomes undefined).
  window.addEventListener("error", (event) => {
    const msg = event.message ?? "";
    if (
      msg.includes("Extension context invalidated") ||
      (msg.includes("Cannot read properties of undefined") && msg.includes("runtime"))
    ) {
      event.preventDefault();
      for (const { destroy } of cleanups) destroy();
      // F6: remove the shared shadow host once, after all detectors tore down.
      removeShadowHost();
    }
  });
}
