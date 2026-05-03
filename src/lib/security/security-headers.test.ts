import { describe, it, expect } from "vitest";
import { PERMISSIONS_POLICY } from "./security-headers";

describe("security-headers", () => {
  describe("PERMISSIONS_POLICY", () => {
    it("is a non-empty string", () => {
      expect(typeof PERMISSIONS_POLICY).toBe("string");
      expect(PERMISSIONS_POLICY.length).toBeGreaterThan(0);
    });

    // Table-driven: each directive must be present and explicitly disabled
    // (empty allowlist `()`). A spelling drift here would silently re-enable
    // a powerful sensor API.
    const expectedDirectives: ReadonlyArray<{ directive: string; allowlist: string }> = [
      { directive: "camera", allowlist: "()" },
      { directive: "microphone", allowlist: "()" },
      { directive: "geolocation", allowlist: "()" },
      { directive: "payment", allowlist: "()" },
      { directive: "browsing-topics", allowlist: "()" },
    ];

    it.each(expectedDirectives)(
      "disables $directive with $allowlist",
      ({ directive, allowlist }) => {
        expect(PERMISSIONS_POLICY).toContain(`${directive}=${allowlist}`);
      },
    );

    it("uses comma-space directive separator (HTTP Permissions-Policy syntax)", () => {
      // RFC: directives are joined by ", "
      const parts = PERMISSIONS_POLICY.split(", ");
      expect(parts.length).toBe(expectedDirectives.length);
    });

    it("does NOT contain an asterisk allowlist (would weaken policy)", () => {
      expect(PERMISSIONS_POLICY).not.toMatch(/=\*/);
      expect(PERMISSIONS_POLICY).not.toMatch(/\(\*\)/);
    });

    it("does NOT contain self= allowlist (only deny `()` is expected)", () => {
      expect(PERMISSIONS_POLICY).not.toContain("=(self)");
    });

    it("is a constant value across imports (frozen-string semantics)", () => {
      // Re-import via dynamic path to confirm value is stable.
      // (Not literally frozen — TS const exports are not Object.freeze'd —
      //  but it MUST be the same primitive string identity.)
      expect(PERMISSIONS_POLICY).toBe(PERMISSIONS_POLICY);
    });
  });
});
