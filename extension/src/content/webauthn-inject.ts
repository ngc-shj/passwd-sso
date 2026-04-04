// Injects the MAIN world WebAuthn interceptor at document_start.
// Must run before page JS to override navigator.credentials.
// Uses <script src> with chrome.runtime.getURL() so CRXJS path
// resolution works correctly regardless of build output paths.

const GUARD = "__pssoWebAuthnInject";
if (!(window as unknown as Record<string, boolean>)[GUARD]) {
  (window as unknown as Record<string, boolean>)[GUARD] = true;

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/content/webauthn-interceptor.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    // Extension context invalidated or DOM not ready
  }
}
