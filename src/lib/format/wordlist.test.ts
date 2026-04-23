import { describe, expect, it } from "vitest";
import { WORDLIST } from "./wordlist";

describe("WORDLIST", () => {
  it("contains at least 1000 words for sufficient entropy", () => {
    expect(WORDLIST.length).toBeGreaterThanOrEqual(1000);
  });

  it("contains only lowercase alphabetic strings", () => {
    for (const word of WORDLIST) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it("has words between 3 and 8 characters", () => {
    for (const word of WORDLIST) {
      expect(word.length).toBeGreaterThanOrEqual(3);
      expect(word.length).toBeLessThanOrEqual(8);
    }
  });

  it("has no duplicate words", () => {
    const unique = new Set(WORDLIST);
    expect(unique.size).toBe(WORDLIST.length);
  });

  it("provides ~10 bits of entropy per word", () => {
    const bitsPerWord = Math.log2(WORDLIST.length);
    expect(bitsPerWord).toBeGreaterThanOrEqual(10);
  });
});
