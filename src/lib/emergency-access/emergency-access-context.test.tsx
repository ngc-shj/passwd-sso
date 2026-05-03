// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  EmergencyAccessProvider,
  confirmPendingEmergencyGrants,
} from "./emergency-access-context";
import { VAULT_STATUS } from "@/lib/constants";
import {
  generateECDHKeyPair,
  exportPublicKey,
} from "@/lib/crypto/crypto-emergency";

// These tests run real Web Crypto end-to-end through the public surface
// (confirmPendingEmergencyGrants + the provider's polling effect). Per the P6
// plan, NO mocks of @/lib/crypto/* are allowed — only fetch is mocked.

describe("confirmPendingEmergencyGrants (real crypto)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns silently when the pending-confirmations endpoint is not OK", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const secret = new Uint8Array(32).fill(1);

    await expect(
      confirmPendingEmergencyGrants(secret, "owner-1", 1),
    ).resolves.toBeUndefined();
    // Only one call — the server endpoint
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("posts a real key-escrow to the confirm endpoint for each pending grant", async () => {
    // Build a real ECDH grantee public key — exercises real createKeyEscrow.
    const granteeKp = await generateECDHKeyPair();
    const granteePubJwk = await exportPublicKey(granteeKp.publicKey);

    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, body: parsed });
      if (url === "/api/emergency-access/pending-confirmations") {
        return {
          ok: true,
          json: async () => [
            {
              id: "grant-1",
              granteeId: "grantee-1",
              granteePublicKey: granteePubJwk,
            },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    await confirmPendingEmergencyGrants(secret, "owner-1", 7);

    expect(calls[0]?.url).toBe("/api/emergency-access/pending-confirmations");
    expect(calls[1]?.url).toBe("/api/emergency-access/grant-1/confirm");
    const escrow = calls[1]?.body as Record<string, unknown>;
    // Real escrow shape — these fields all originate from real Web Crypto.
    expect(typeof escrow.encryptedSecretKey).toBe("string");
    expect(typeof escrow.secretKeyIv).toBe("string");
    expect(typeof escrow.secretKeyAuthTag).toBe("string");
    expect(typeof escrow.hkdfSalt).toBe("string");
    expect(typeof escrow.ownerEphemeralPublicKey).toBe("string");
    expect(escrow.keyVersion).toBe(7);
    expect(escrow.wrapVersion).toBe(1);
    // Hex-encoded fields — non-empty
    expect((escrow.secretKeyIv as string).length).toBeGreaterThan(0);
  });

  it("skips grants whose granteePublicKey is malformed and continues processing", async () => {
    const grantee = await generateECDHKeyPair();
    const valid = await exportPublicKey(grantee.publicKey);

    const confirmCalls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === "/api/emergency-access/pending-confirmations") {
        return {
          ok: true,
          json: async () => [
            { id: "bad", granteeId: "g-bad", granteePublicKey: "not-a-jwk" },
            { id: "good", granteeId: "g-good", granteePublicKey: valid },
          ],
        };
      }
      confirmCalls.push(url);
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const secret = new Uint8Array(32).fill(2);
    await confirmPendingEmergencyGrants(secret, "owner-1", 1);

    // The malformed grant must be skipped silently; the valid grant must succeed.
    expect(confirmCalls).toEqual(["/api/emergency-access/good/confirm"]);
  });
});

describe("EmergencyAccessProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("does not poll when vault is locked", () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <EmergencyAccessProvider
        vaultStatus={VAULT_STATUS.LOCKED}
        getSecretKey={() => new Uint8Array(32)}
        keyVersion={1}
        userId="u1"
      >
        <div />
      </EmergencyAccessProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not poll when userId is undefined", () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <EmergencyAccessProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        getSecretKey={() => new Uint8Array(32)}
        keyVersion={1}
        userId={undefined}
      >
        <div />
      </EmergencyAccessProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("immediately calls the pending-confirmations endpoint on unlock", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    await act(async () => {
      render(
        <EmergencyAccessProvider
          vaultStatus={VAULT_STATUS.UNLOCKED}
          getSecretKey={() => new Uint8Array(32).fill(3)}
          keyVersion={2}
          userId="u1"
        >
          <div />
        </EmergencyAccessProvider>,
      );
      // flush microtasks so the synchronous run() inside the effect fires fetch
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/emergency-access/pending-confirmations",
    );
  });

  it("does not call when getSecretKey() returns null even if status is UNLOCKED", () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <EmergencyAccessProvider
        vaultStatus={VAULT_STATUS.UNLOCKED}
        getSecretKey={() => null}
        keyVersion={1}
        userId="u1"
      >
        <div />
      </EmergencyAccessProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes listeners and stops polling on unmount", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const removeDocSpy = vi.spyOn(document, "removeEventListener");
    const removeWinSpy = vi.spyOn(window, "removeEventListener");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    let unmount: () => void = () => {};
    await act(async () => {
      const r = render(
        <EmergencyAccessProvider
          vaultStatus={VAULT_STATUS.UNLOCKED}
          getSecretKey={() => new Uint8Array(32)}
          keyVersion={1}
          userId="u1"
        >
          <div />
        </EmergencyAccessProvider>,
      );
      unmount = r.unmount;
      await Promise.resolve();
    });

    const callsBefore = fetchMock.mock.calls.length;

    unmount();

    expect(removeDocSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWinSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(clearIntervalSpy).toHaveBeenCalled();

    // After unmount, advancing timers must NOT trigger more polls
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    removeDocSpy.mockRestore();
    removeWinSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
