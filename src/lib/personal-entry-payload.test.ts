import { describe, expect, it } from "vitest";
import { buildPasswordHistory, buildPersonalEntryPayload } from "@/lib/personal-entry-payload";

describe("buildPasswordHistory", () => {
  it("prepends previous password when changed", () => {
    const result = buildPasswordHistory(
      "old",
      "new",
      [{ password: "older", changedAt: "2026-01-01T00:00:00.000Z" }],
      "2026-02-01T00:00:00.000Z"
    );
    expect(result[0]).toEqual({
      password: "old",
      changedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result).toHaveLength(2);
  });

  it("returns existing history when password unchanged", () => {
    const existing = [{ password: "older", changedAt: "2026-01-01T00:00:00.000Z" }];
    const result = buildPasswordHistory(
      "same",
      "same",
      existing,
      "2026-02-01T00:00:00.000Z"
    );
    expect(result).toEqual(existing);
  });
});

describe("buildPersonalEntryPayload", () => {
  it("creates full and overview blobs with normalized optional fields", () => {
    const { fullBlob, overviewBlob } = buildPersonalEntryPayload({
      title: "Example",
      username: "",
      password: "pw",
      url: "https://example.com/path",
      notes: "",
      selectedTags: [{ name: "work", color: null }],
      generatorSettings: {
        mode: "password",
        length: 20,
        uppercase: true,
        lowercase: true,
        numbers: true,
        symbolGroups: {
          hashEtc: true,
          punctuation: false,
          quotes: false,
          slashDash: false,
          mathCompare: false,
          brackets: false,
        },
        excludeAmbiguous: false,
        includeChars: "",
        excludeChars: "",
        passphrase: { wordCount: 4, separator: "-", capitalize: false, includeNumber: false },
      },
      customFields: [
        { label: "env", value: "prod", type: "text" },
        { label: "", value: "skip", type: "text" },
      ],
      totp: null,
      requireReprompt: true,
      existingHistory: [],
    });

    const full = JSON.parse(fullBlob) as Record<string, unknown>;
    const overview = JSON.parse(overviewBlob) as Record<string, unknown>;

    expect(full.username).toBeNull();
    expect(full.url).toBe("https://example.com/path");
    expect(full.notes).toBeNull();
    expect(Array.isArray(full.customFields)).toBe(true);
    expect((full.customFields as unknown[]).length).toBe(1);
    expect(overview.urlHost).toBe("example.com");
    expect(overview.requireReprompt).toBe(true);
  });
});

