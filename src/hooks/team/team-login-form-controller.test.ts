import { describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import type { TeamTagData } from "@/components/team/team-tag-input";
import { createTeamLoginSubmitHandler } from "@/hooks/team/team-login-form-controller";

function buildValues(overrides: Partial<{ title: string; username: string; password: string }> = {}) {
  return {
    title: overrides.title ?? "title",
    username: overrides.username ?? "user",
    password: overrides.password ?? "pass",
    url: "",
    notes: "",
    selectedTags: [] as TeamTagData[],
    customFields: [],
    totp: null,
  };
}

describe("createTeamLoginSubmitHandler", () => {
  it("does not call submitEntry when submitDisabled is true", async () => {
    const submitEntry = vi.fn();
    const vals = buildValues();

    const handler = createTeamLoginSubmitHandler({
      submitDisabled: true,
      submitEntry,
      ...vals,
    });

    const preventDefault = vi.fn();
    await handler({ preventDefault } as unknown as React.FormEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitEntry).not.toHaveBeenCalled();
  });

  it("builds tagNames from selectedTags with name and color", async () => {
    const submitEntry = vi.fn().mockResolvedValue(undefined);
    const selectedTags: TeamTagData[] = [
      { id: "t1", name: "work", color: "#ff0000" },
      { id: "t2", name: "finance", color: null },
    ];
    const vals = buildValues();

    const handler = createTeamLoginSubmitHandler({
      submitDisabled: false,
      submitEntry,
      ...vals,
      selectedTags,
    });

    await handler({ preventDefault: vi.fn() } as unknown as React.FormEvent);

    expect(submitEntry).toHaveBeenCalledTimes(1);
    const payload = submitEntry.mock.calls[0]?.[0];
    expect(payload.tagNames).toEqual([
      { name: "work", color: "#ff0000" },
      { name: "finance", color: null },
    ]);
  });

  it("submits with correct payload on success", async () => {
    const submitEntry = vi.fn().mockResolvedValue(undefined);
    const vals = buildValues({ title: "My Login", username: "admin", password: "secret" });

    const handler = createTeamLoginSubmitHandler({
      submitDisabled: false,
      submitEntry,
      ...vals,
      url: "https://example.com",
      notes: "some notes",
      selectedTags: [],
      customFields: [],
      totp: null,
    });

    const preventDefault = vi.fn();
    await handler({ preventDefault } as unknown as React.FormEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitEntry).toHaveBeenCalledTimes(1);
    expect(submitEntry.mock.calls[0]?.[0]).toMatchObject({
      entryType: ENTRY_TYPE.LOGIN,
      title: "My Login",
      username: "admin",
      password: "secret",
      url: "https://example.com",
      notes: "some notes",
      tagNames: [],
      customFields: [],
      totp: null,
    });
  });
});
