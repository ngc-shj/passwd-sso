import { describe, expect, it } from "vitest";
import {
  buildPersonalCurrentSnapshot,
  buildPersonalInitialSnapshot,
} from "@/hooks/personal-password-form-derived";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";

describe("personal-password-form-derived snapshot helpers", () => {
  it("builds initial snapshot with defaults", () => {
    const snapshot = JSON.parse(buildPersonalInitialSnapshot());
    expect(snapshot.title).toBe("");
    expect(snapshot.tags).toEqual([]);
    expect(snapshot.requireReprompt).toBe(false);
    expect(snapshot.folderId).toBeNull();
  });

  it("builds current snapshot with provided values", () => {
    const snapshot = JSON.parse(
      buildPersonalCurrentSnapshot({
        title: "Title",
        username: "user@example.com",
        password: "secret",
        url: "https://example.com",
        notes: "notes",
        tags: [{ id: "t1", name: "Tag", color: "#ffffff" }],
        generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS, length: 16 },
        customFields: [],
        totp: null,
        requireReprompt: true,
        folderId: "folder-1",
      }),
    );

    expect(snapshot.title).toBe("Title");
    expect(snapshot.username).toBe("user@example.com");
    expect(snapshot.requireReprompt).toBe(true);
    expect(snapshot.folderId).toBe("folder-1");
  });
});
