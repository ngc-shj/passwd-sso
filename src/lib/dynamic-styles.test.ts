// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";

// Use resetModules to get a fresh module state per test group
// (tagColorRules Set and cachedNonce are module-level singletons)

describe("getTagColorClass", () => {
  beforeEach(() => {
    // Clean DOM
    document.head.innerHTML = "";
    document.querySelectorAll('meta[name="csp-nonce"]').forEach((el) => el.remove());
  });

  it("returns null for null or empty color", async () => {
    const getTagColorClass = (await import("./dynamic-styles")).getTagColorClass;
    expect(getTagColorClass(null)).toBeNull();
    expect(getTagColorClass("")).toBeNull();
  });

  it("returns null for invalid hex format", async () => {
    const { getTagColorClass } = await import("./dynamic-styles");
    expect(getTagColorClass("red")).toBeNull();
    expect(getTagColorClass("#fff")).toBeNull();
    expect(getTagColorClass("#GGGGGG")).toBeNull();
    expect(getTagColorClass("123456")).toBeNull();
  });

  it("returns class name for valid 6-digit hex", async () => {
    const { getTagColorClass } = await import("./dynamic-styles");
    const result = getTagColorClass("#ff5733");
    expect(result).toBe("tag-color-ff5733");
  });

  it("normalizes uppercase hex to lowercase", async () => {
    const { getTagColorClass } = await import("./dynamic-styles");
    const result = getTagColorClass("#FF5733");
    expect(result).toBe("tag-color-ff5733");
  });

  it("injects CSS rule into a style element in head", async () => {
    const { getTagColorClass } = await import("./dynamic-styles");
    getTagColorClass("#aabbcc");
    const style = document.getElementById("tag-color-styles") as HTMLStyleElement;
    expect(style).not.toBeNull();
    expect(style.textContent).toContain(".tag-color-aabbcc{--tag-color:#aabbcc;}");
  });

  it("does not duplicate rules for same color", async () => {
    const { getTagColorClass } = await import("./dynamic-styles");
    getTagColorClass("#112233");
    getTagColorClass("#112233");
    const style = document.getElementById("tag-color-styles") as HTMLStyleElement;
    const matches = style!.textContent!.match(/tag-color-112233/g);
    // May have more than 1 if previous tests added it, but within this call sequence
    // the second call should not re-append
    expect(matches!.length).toBe(1);
  });

  it("sets nonce from meta tag when present", async () => {
    // Must get fresh module to reset cachedNonce
    vi.resetModules();
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "test-nonce-123";
    document.head.appendChild(meta);

    const { getTagColorClass } = await import("./dynamic-styles");
    getTagColorClass("#001122");
    const style = document.getElementById("tag-color-styles") as HTMLStyleElement;
    expect(style?.getAttribute("nonce")).toBe("test-nonce-123");
  });
});
