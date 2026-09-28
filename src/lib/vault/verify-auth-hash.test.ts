import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { compareVaultAuthHash } from "@/lib/vault/verify-auth-hash";

function serverHashFor(authHash: string, salt: string): string {
  return createHash("sha256").update(authHash + salt).digest("hex");
}

describe("compareVaultAuthHash", () => {
  const salt = "a".repeat(64);
  const authHash = "b".repeat(64);
  const masterPasswordServerHash = serverHashFor(authHash, salt);

  it("returns true when the authHash matches the stored server hash", () => {
    expect(
      compareVaultAuthHash(authHash, { masterPasswordServerHash, masterPasswordServerSalt: salt }),
    ).toBe(true);
  });

  it("returns false when the authHash does not match", () => {
    const wrongAuthHash = "c".repeat(64);
    expect(
      compareVaultAuthHash(wrongAuthHash, { masterPasswordServerHash, masterPasswordServerSalt: salt }),
    ).toBe(false);
  });

  it("returns false on a length mismatch instead of throwing", () => {
    expect(
      compareVaultAuthHash(authHash, {
        masterPasswordServerHash: masterPasswordServerHash.slice(0, -2),
        masterPasswordServerSalt: salt,
      }),
    ).toBe(false);
  });
});
