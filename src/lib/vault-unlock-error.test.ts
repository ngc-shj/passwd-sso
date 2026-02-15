import { describe, it, expect } from "vitest";
import { VaultUnlockError } from "./vault-context";

describe("VaultUnlockError", () => {
  it("stores code and lockedUntil", () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString();
    const err = new VaultUnlockError("ACCOUNT_LOCKED", lockedUntil);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VaultUnlockError);
    expect(err.name).toBe("VaultUnlockError");
    expect(err.code).toBe("ACCOUNT_LOCKED");
    expect(err.lockedUntil).toBe(lockedUntil);
    expect(err.message).toBe("ACCOUNT_LOCKED");
  });

  it("defaults lockedUntil to undefined", () => {
    const err = new VaultUnlockError("RATE_LIMIT_EXCEEDED");
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.lockedUntil).toBeUndefined();
  });

  it("accepts null lockedUntil", () => {
    const err = new VaultUnlockError("SERVICE_UNAVAILABLE", null);
    expect(err.lockedUntil).toBeNull();
  });
});
