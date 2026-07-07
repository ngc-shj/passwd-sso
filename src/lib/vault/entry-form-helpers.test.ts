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
    const tags = [{ name: "Tag", color: "#000", extra: "ignored" } as unknown as {
      name: string;
      color: string | null;
    }];
    const result = toTagNameColor(tags);
    expect(Object.keys(result[0])).toEqual(["name", "color"]);
  });

  it("returns empty array for empty input", () => {
    expect(toTagNameColor([])).toEqual([]);
  });
});

// ─── filterNonEmptyCustomFields ──────────────────────────────

describe("filterNonEmptyCustomFields", () => {
  // Keep any touched field (label OR value present); drop only untouched rows.

  it("keeps a label-less URL field (reported repro — was silently dropped)", () => {
    const fields = [{ label: "", value: "https://example.com", type: "url" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("keeps a value-only text field regardless of label", () => {
    const fields = [{ label: "", value: "456", type: "text" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("keeps a label-only field with empty value (no silent loss of a titled row)", () => {
    const fields = [{ label: "note", value: "", type: "text" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("keeps a HIDDEN field with a value and no label", () => {
    const fields = [{ label: "", value: "secret", type: "hidden" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("keeps DATE and MONTH_YEAR fields with values and no label", () => {
    const fields = [
      { label: "", value: "2026-01-01", type: "date" as const },
      { label: "", value: "2026-03", type: "monthYear" as const },
    ];
    expect(filterNonEmptyCustomFields(fields)).toHaveLength(2);
  });

  it("drops a fully-empty row (untouched)", () => {
    expect(
      filterNonEmptyCustomFields([{ label: "", value: "", type: "text" as const }])
    ).toEqual([]);
  });

  it("drops a whitespace-only label + whitespace-only value row (untouched)", () => {
    expect(
      filterNonEmptyCustomFields([{ label: "   ", value: "   ", type: "text" as const }])
    ).toEqual([]);
  });

  it("drops a whitespace-only value with no label (guards value.trim not value !== '')", () => {
    expect(
      filterNonEmptyCustomFields([{ label: "", value: "   ", type: "text" as const }])
    ).toEqual([]);
  });

  it("keeps a turned-on boolean with no label", () => {
    const fields = [{ label: "", value: "true", type: "boolean" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("drops an untouched (off, unlabelled) boolean", () => {
    expect(
      filterNonEmptyCustomFields([{ label: "", value: "false", type: "boolean" as const }])
    ).toEqual([]);
  });

  it("keeps a labelled off boolean", () => {
    const fields = [{ label: "agreed", value: "false", type: "boolean" as const }];
    expect(filterNonEmptyCustomFields(fields)).toEqual(fields);
  });

  it("preserves the order of surviving fields in a mixed keep/drop array", () => {
    const fields = [
      { label: "a", value: "1", type: "text" as const },
      { label: "", value: "", type: "text" as const },
      { label: "", value: "2", type: "url" as const },
    ];
    expect(filterNonEmptyCustomFields(fields)).toEqual([
      { label: "a", value: "1", type: "text" },
      { label: "", value: "2", type: "url" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(filterNonEmptyCustomFields([])).toEqual([]);
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

  it("returns null for authority-less schemes whose hostname is empty", () => {
    // javascript:/data:/mailto: parse successfully but have an empty hostname;
    // normalize to null so "" never lands in a urlHost field.
    expect(parseUrlHost("javascript:alert(1)")).toBeNull();
    expect(parseUrlHost("data:text/plain,hi")).toBeNull();
    expect(parseUrlHost("mailto:a@b.com")).toBeNull();
  });
});
