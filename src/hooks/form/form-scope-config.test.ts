import { describe, it, expect } from "vitest";
import { isPersonalScope, isTeamScope, type FormScopeConfig } from "./form-scope-config";

const personal: FormScopeConfig = {
  scope: "personal",
  encryptionKey: {} as CryptoKey,
  userId: "user-1",
  tagType: "personal",
  folderField: "folderId",
};

const team: FormScopeConfig = {
  scope: "team",
  teamId: "team-1",
  tagType: "team",
  folderField: "teamFolderId",
};

describe("isPersonalScope", () => {
  it("accepts a personal config", () => {
    expect(isPersonalScope(personal)).toBe(true);
  });

  it("rejects a team config", () => {
    expect(isPersonalScope(team)).toBe(false);
  });
});

describe("isTeamScope", () => {
  it("accepts a team config", () => {
    expect(isTeamScope(team)).toBe(true);
  });

  it("rejects a personal config", () => {
    expect(isTeamScope(personal)).toBe(false);
  });
});
