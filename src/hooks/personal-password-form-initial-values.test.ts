import { describe, expect, it } from "vitest";
import { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";

describe("buildPersonalPasswordFormInitialValues", () => {
  it("returns defaults when initial data is missing", () => {
    const result = buildPersonalPasswordFormInitialValues();

    expect(result.title).toBe("");
    expect(result.username).toBe("");
    expect(result.password).toBe("");
    expect(result.showTotpInput).toBe(false);
    expect(result.requireReprompt).toBe(false);
    expect(result.folderId).toBeNull();
  });

  it("maps initial data and derived flags", () => {
    const result = buildPersonalPasswordFormInitialValues({
      id: "entry-1",
      title: "title",
      username: "user",
      password: "pass",
      url: "https://example.com",
      notes: "memo",
      tags: [],
      folderId: "folder-1",
      requireReprompt: true,
      totp: { secret: "secret", period: 30, digits: 6 },
    });

    expect(result.title).toBe("title");
    expect(result.username).toBe("user");
    expect(result.notes).toBe("memo");
    expect(result.folderId).toBe("folder-1");
    expect(result.requireReprompt).toBe(true);
    expect(result.showTotpInput).toBe(true);
  });
});
