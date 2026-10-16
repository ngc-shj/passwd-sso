// Fill-only content entry, built as one classic script (vite.fill.config.ts)
// for pages outside the manifest content-script scope, such as plain http://
// hosts. The manifest bundle's CRXJS loader starts its code with import(), and
// a page the bundle's web_accessible_resources do not match refuses that
// import; a classic script injected through executeScript `files` needs no such
// grant. Only the fill listeners go in: no detectors, no inline UI and no
// WebAuthn bridge reach a page the manifest leaves out. Each listener module
// guards its own registration, so a second injection adds nothing.
import "./autofill-lib";
import "./autofill-cc-lib";
import "./autofill-identity-lib";
