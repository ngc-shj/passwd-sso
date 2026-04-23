import { describe, it, expect } from "vitest";
import { SECURE_NOTE_TEMPLATES } from "./secure-note-templates";

describe("SECURE_NOTE_TEMPLATES", () => {
  it("has unique IDs", () => {
    const ids = SECURE_NOTE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(SECURE_NOTE_TEMPLATES.length);
  });

  it("all templates have a titleKey", () => {
    for (const t of SECURE_NOTE_TEMPLATES) {
      expect(t.titleKey).toBeTruthy();
      expect(typeof t.titleKey).toBe("string");
    }
  });

  it("all templates have contentTemplate as string", () => {
    for (const t of SECURE_NOTE_TEMPLATES) {
      expect(typeof t.contentTemplate).toBe("string");
    }
  });

  it("blank template has empty content", () => {
    const blank = SECURE_NOTE_TEMPLATES.find((t) => t.id === "blank");
    expect(blank).toBeDefined();
    expect(blank!.contentTemplate).toBe("");
  });

  it("non-blank templates have content", () => {
    const nonBlank = SECURE_NOTE_TEMPLATES.filter((t) => t.id !== "blank");
    for (const t of nonBlank) {
      expect(t.contentTemplate.length).toBeGreaterThan(0);
    }
  });
});
