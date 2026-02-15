import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultUnlockError, notifyUnlockFailure } from "./vault-context";

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

describe("notifyUnlockFailure", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws VaultUnlockError with ACCOUNT_LOCKED on 403", async () => {
    const lockedUntil = "2026-02-16T01:00:00Z";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "ACCOUNT_LOCKED", lockedUntil }),
    }));

    const err = await notifyUnlockFailure().catch((e) => e);
    expect(err).toBeInstanceOf(VaultUnlockError);
    expect(err.code).toBe("ACCOUNT_LOCKED");
    expect(err.lockedUntil).toBe(lockedUntil);
  });

  it("throws VaultUnlockError with RATE_LIMIT_EXCEEDED on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "RATE_LIMIT_EXCEEDED" }),
    }));

    await expect(notifyUnlockFailure()).rejects.toThrow(VaultUnlockError);
    const err = await notifyUnlockFailure().catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("throws VaultUnlockError with SERVICE_UNAVAILABLE on 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "SERVICE_UNAVAILABLE" }),
    }));

    const err = await notifyUnlockFailure().catch((e) => e);
    expect(err).toBeInstanceOf(VaultUnlockError);
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("does not throw when server returns ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
    }));

    await expect(notifyUnlockFailure()).resolves.toBeUndefined();
  });

  it("does not throw when server returns error-less non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    }));

    await expect(notifyUnlockFailure()).resolves.toBeUndefined();
  });

  it("does not throw when response body is not valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error("invalid json")),
    }));

    await expect(notifyUnlockFailure()).resolves.toBeUndefined();
  });

  it("sends dummy authHash in request body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await notifyUnlockFailure();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/vault/unlock",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ authHash: "0".repeat(64) }),
      }),
    );
  });
});

describe("unlock() VaultUnlockError re-throw pattern", () => {
  // Tests the exact catch pattern used in vault-context.tsx unlock():
  //   inner: try { await notifyUnlockFailure(); } catch (e) { if (e instanceof VaultUnlockError) throw e; }
  //   outer: catch (err) { if (err instanceof VaultUnlockError) throw err; return false; }

  it("propagates VaultUnlockError through nested catch blocks", async () => {
    const simulateUnlock = async () => {
      try {
        // Simulate unwrapSecretKey failure
        try {
          throw new Error("AES-GCM decrypt failed");
        } catch {
          try {
            throw new VaultUnlockError("ACCOUNT_LOCKED", "2026-02-16T01:00:00Z");
          } catch (e) {
            if (e instanceof VaultUnlockError) throw e;
          }
          return false;
        }
      } catch (err) {
        if (err instanceof VaultUnlockError) throw err;
        return false;
      }
    };

    await expect(simulateUnlock()).rejects.toThrow(VaultUnlockError);
    const err = await simulateUnlock().catch((e) => e);
    expect(err.code).toBe("ACCOUNT_LOCKED");
  });

  it("returns false when notifyUnlockFailure throws non-VaultUnlockError", async () => {
    const simulateUnlock = async () => {
      try {
        try {
          throw new Error("AES-GCM decrypt failed");
        } catch {
          try {
            throw new TypeError("network error");
          } catch (e) {
            if (e instanceof VaultUnlockError) throw e;
            // non-VaultUnlockError swallowed
          }
          return false;
        }
      } catch (err) {
        if (err instanceof VaultUnlockError) throw err;
        return false;
      }
    };

    await expect(simulateUnlock()).resolves.toBe(false);
  });
});
