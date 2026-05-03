import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn (classname helper)", () => {
  it("joins simple string class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("returns empty string when no inputs are provided", () => {
    expect(cn()).toBe("");
  });

  it("ignores falsy values (undefined / null / false)", () => {
    expect(cn("foo", undefined, null, false, "bar")).toBe("foo bar");
  });

  it("supports conditional object syntax (clsx)", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("flattens nested arrays", () => {
    expect(cn(["foo", ["bar", "baz"]])).toBe("foo bar baz");
  });

  it("merges tailwind classes deduplicating later wins (twMerge)", () => {
    // px-2 should be removed in favor of px-4 by twMerge
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("merges conflicting bg-color tailwind utilities (last wins)", () => {
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  it("preserves non-conflicting tailwind classes", () => {
    expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold");
  });
});
