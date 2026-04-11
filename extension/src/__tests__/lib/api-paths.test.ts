import { describe, expect, it } from "vitest";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";

describe("api paths", () => {
  it("defines stable extension api paths", () => {
    expect(EXT_API_PATH.EXTENSION_TOKEN).toBe("/api/extension/token");
    expect(EXT_API_PATH.EXTENSION_TOKEN_REFRESH).toBe(
      "/api/extension/token/refresh"
    );
    expect(EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE).toBe(
      "/api/extension/token/exchange"
    );
    expect(EXT_API_PATH.PASSWORDS).toBe("/api/passwords");
    expect(EXT_API_PATH.VAULT_UNLOCK_DATA).toBe("/api/vault/unlock/data");
    expect(EXT_API_PATH.TEAMS).toBe("/api/teams");
  });

  it("builds password detail path", () => {
    expect(extApiPath.passwordById("pw-1")).toBe("/api/passwords/pw-1");
  });

  it("builds team member-key path", () => {
    expect(extApiPath.teamMemberKey("t-1")).toBe("/api/teams/t-1/member-key");
  });

  it("builds team passwords path", () => {
    expect(extApiPath.teamPasswords("t-1")).toBe("/api/teams/t-1/passwords");
  });

  it("builds team password by id path", () => {
    expect(extApiPath.teamPasswordById("t-1", "pw-1")).toBe(
      "/api/teams/t-1/passwords/pw-1"
    );
  });
});
