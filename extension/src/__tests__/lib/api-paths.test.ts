import { describe, expect, it } from "vitest";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";

describe("api paths", () => {
  it("defines stable extension api paths", () => {
    expect(EXT_API_PATH.EXTENSION_TOKEN_REFRESH).toBe(
      "/api/extension/token/refresh"
    );
    expect(EXT_API_PATH.PASSWORDS).toBe("/api/passwords");
    expect(EXT_API_PATH.VAULT_UNLOCK_DATA).toBe("/api/vault/unlock/data");
  });

  it("builds password detail path", () => {
    expect(extApiPath.passwordById("pw-1")).toBe("/api/passwords/pw-1");
  });
});

