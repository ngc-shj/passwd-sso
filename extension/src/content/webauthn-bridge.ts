// WebAuthn bridge entry point — ISOLATED world content script.
// Imported by form-detector.ts alongside autofill-lib.

import { handleWebAuthnMessage } from "./webauthn-bridge-lib";

const GUARD_KEY = "__pssoWebAuthnBridge";
if (!(window as unknown as Record<string, boolean>)[GUARD_KEY]) {
  (window as unknown as Record<string, boolean>)[GUARD_KEY] = true;
  window.addEventListener("message", handleWebAuthnMessage);

  // Tell MAIN world interceptor to bypass all WebAuthn interception on own app pages.
  // This must happen early so the flag is set before any WebAuthn API call.
  chrome.storage.local.get("serverUrl", ({ serverUrl }) => {
    if (typeof serverUrl !== "string" || !serverUrl) return;
    try {
      const base = new URL(serverUrl);
      const page = new URL(window.location.href);
      if (page.origin !== base.origin) return;
      const bp = base.pathname || "/";
      if (page.pathname === bp || page.pathname.startsWith(bp.endsWith("/") ? bp : `${bp}/`)) {
        window.postMessage({ type: "PASSWD_SSO_OWN_APP_BYPASS" }, window.location.origin);
      }
    } catch { /* invalid URL — ignore */ }
  });
}
