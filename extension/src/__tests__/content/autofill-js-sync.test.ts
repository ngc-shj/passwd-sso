import { describe, expect, it } from "vitest";

// autofill.js is the hand-maintained plain-JS production content script
// (autofill-lib.ts is the typed test-only twin). A security control added to
// the .ts twin but not to .js would silently ship the vulnerable version while
// unit tests (which import the .ts twin) stay green — the RT4 vacuous-guard
// trap. These tests assert the frame-origin gate is present in the production
// artifact itself.
describe("autofill.js sync — frame-origin gate", () => {
  it("gates performAutofill on isFrameAllowedToFill", async () => {
    const { default: file } = await import("../../content/autofill.js?raw");
    const normalized = file.replace(/\s+/g, " ");
    // The credential write must be preceded by the frame gate, failing closed.
    expect(normalized).toMatch(
      /function performAutofill\(payload\) \{ \/\/[^\n]*if \(!isFrameAllowedToFill\(payload\.allowedHosts\)\) return;/,
    );
  });

  it("top frame is always allowed; a subframe requires a matching host", async () => {
    const { default: file } = await import("../../content/autofill.js?raw");
    const normalized = file.replace(/\s+/g, " ");
    expect(normalized).toContain("if (window.top === window.self) return true;");
    // Fail closed when the frame origin cannot be resolved.
    expect(normalized).toMatch(/if \(!frameHost\) return false;/);
  });
});
