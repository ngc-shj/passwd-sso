import { describe, it, expect, vi } from "vitest";
import { masked, warn } from "../../lib/output.js";

describe("output", () => {
  describe("warn", () => {
    it("writes to stderr via console.error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      warn("test warning");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("test warning"));
      spy.mockRestore();
    });
  });

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
