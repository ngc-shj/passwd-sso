import { describe, expect, it } from "vitest";
import {
  extractTagIds,
  toTagNameColor,
  filterNonEmptyCustomFields,
  parseUrlHost,
} from "./entry-form-helpers";

// ─── extractTagIds ───────────────────────────────────────────

describe("extractTagIds", () => {
  it("extracts ids from tag objects", () => {
    expect(extractTagIds([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
  });

  it("returns empty array for empty input", () => {
    expect(extractTagIds([])).toEqual([]);
  });
});

// ─── toTagNameColor ──────────────────────────────────────────

describe("toTagNameColor", () => {
  it("maps tags to name/color objects", () => {
    const tags = [
      { name: "Work", color: "#ff0000" },
      { name: "Personal", color: null },
    ];
    expect(toTagNameColor(tags)).toEqual([
      { name: "Work", color: "#ff0000" },
      { name: "Personal", color: null },
    ]);
  });

  it("strips extra properties from tag objects", () => {
    const tags = [{ name: "Tag", color: "#000", extra: "ignored" }] as {
      name: string;
      color: string | null;
    }[];
    const result = toTagNameColor(tags);
    expect(Object.keys(result[0])).toEqual(["name", "color"]);
  });

  it("returns empty array for empty input", () => {
    expect(toTagNameColor([])).toEqual([]);
  });
});

// ─── filterNonEmptyCustomFields ──────────────────────────────

describe("filterNonEmptyCustomFields", () => {
  it("keeps fields with non-empty label and value", () => {
    const fields = [
      { label: "api_key", value: "123" },
      { label: "", value: "456" },
      { label: "name", value: "" },
      { label: "  ", value: "trimmed" },
    ];
    expect(filterNonEmptyCustomFields(fields)).toEqual([
      { label: "api_key", value: "123" },
    ]);
  });

  it("returns empty array when all fields are empty", () => {
    expect(filterNonEmptyCustomFields([{ label: "", value: "" }])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterNonEmptyCustomFields([])).toEqual([]);
  });

  it("keeps BOOLEAN field with value 'false' (non-empty)", () => {
    const fields = [
      { label: "toggle", value: "false", type: "boolean" },
    ];
    expect(filterNonEmptyCustomFields(fields)).toHaveLength(1);
    expect(filterNonEmptyCustomFields(fields)[0].value).toBe("false");
  });

  it("filters out BOOLEAN field with empty value", () => {
    const fields = [
      { label: "toggle", value: "", type: "boolean" },
    ];
    expect(filterNonEmptyCustomFields(fields)).toHaveLength(0);
  });

  it("keeps DATE and MONTH_YEAR fields with values", () => {
    const fields = [
      { label: "birthday", value: "2000-01-01", type: "date" },
      { label: "expiry", value: "2026-03", type: "monthYear" },
    ];
    expect(filterNonEmptyCustomFields(fields)).toHaveLength(2);
  });
});

// ─── parseUrlHost ────────────────────────────────────────────

describe("parseUrlHost", () => {
  it("extracts hostname from valid URL", () => {
    expect(parseUrlHost("https://example.com/path")).toBe("example.com");
  });

  it("handles URL with port", () => {
    expect(parseUrlHost("http://localhost:3000")).toBe("localhost");
  });

  it("returns null for empty string", () => {
    expect(parseUrlHost("")).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(parseUrlHost("not-a-url")).toBeNull();
  });

  it("extracts hostname from URL with subdomain", () => {
    expect(parseUrlHost("https://app.example.com")).toBe("app.example.com");
  });
});
