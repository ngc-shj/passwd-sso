import { describe, it, expect } from "vitest";
import { masked } from "../../lib/output.js";

describe("output", () => {
  describe("masked", () => {
    it("masks passwords showing last 4 chars", () => {
      const result = masked("mysecretpassword");
      expect(result).toBe("************word");
    });

    it("returns **** for very short values", () => {
      expect(masked("ab")).toBe("****");
      expect(masked("")).toBe("****");
    });

    it("handles exactly 4 chars", () => {
      expect(masked("abcd")).toBe("****");
    });

    it("handles 5 chars", () => {
      expect(masked("abcde")).toBe("*bcde");
    });
  });
});
