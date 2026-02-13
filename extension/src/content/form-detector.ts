// Content script entry point for form detection + inline autofill.
// Declared in manifest content_scripts → CRXJS bundles via Vite.
// TypeScript and imports work here (unlike web_accessible_resources files).

import { initFormDetector } from "./form-detector-lib";

// iframe guard — only run in top-level frames
if (window === window.top) {
  initFormDetector();
}
