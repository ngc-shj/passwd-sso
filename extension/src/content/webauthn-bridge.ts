// WebAuthn bridge entry point — ISOLATED world content script.
// Imported by form-detector.ts alongside autofill-lib.

import { handleWebAuthnMessage } from "./webauthn-bridge-lib";

const GUARD_KEY = "__pssoWebAuthnBridge";
if (!(window as unknown as Record<string, boolean>)[GUARD_KEY]) {
  (window as unknown as Record<string, boolean>)[GUARD_KEY] = true;
  window.addEventListener("message", handleWebAuthnMessage);
}
