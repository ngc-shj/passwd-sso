// @vitest-environment jsdom
/**
 * VaultProvider under a passkey-blocked or degraded session (plan C2, D6, D7).
 *
 * The proxy refuses every vault endpoint for such a session, so the provider
 * must skip `/api/vault/status` on every run of its status effect, settle
 * LOADING to LOCKED without arming the retry/fallback timers, and leave an
 * existing UNLOCKED state to the auto-lock timer.
 *
 * Every cell sets `passkeyBlocked` OPPOSITE to what the four raw passkey fields
 * would give under the test clock (I5): a provider that re-derived the verdict
 * from the raw fields instead of reading the server's verdict goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

import { VaultProvider, useVault } from "./vault-context";
import { VAULT_STATUS } from "@/lib/constants";

const PASSPHRASE = "correct horse battery staple";
const VAULT_STATUS_PATH = "/api/vault/status";

// Raw fields that `passkeyEnforcementBlocks` reads as NOT blocking.
const RAW_ALLOWED = {
  requirePasskey: false,
  hasPasskey: false,
  requirePasskeyEnabledAt: null,
  passkeyGracePeriodDays: null,
};
// Raw fields that `passkeyEnforcementBlocks` reads as blocking under any clock:
// required, no passkey, enabled long ago with no grace period.
const RAW_BLOCKING = {
  requirePasskey: true,
  hasPasskey: false,
  requirePasskeyEnabledAt: "2020-01-01T00:00:00.000Z",
  passkeyGracePeriodDays: 0,
};

const BLOCKED_USER = { id: "user-1", ...RAW_ALLOWED, passkeyBlocked: true };
const DEGRADED_USER = {
  id: "user-1",
  ...RAW_ALLOWED,
  passkeyBlocked: false,
  passkeyStateDegraded: true,
};
const ALLOWED_USER = { id: "user-1", ...RAW_BLOCKING, passkeyBlocked: false };

const wrapper = ({ children }: { children: ReactNode }) => (
  <VaultProvider>{children}</VaultProvider>
);

const update = vi.fn();

function setSessionUser(user: Record<string, unknown>) {
  // A new data object per call, as a real session update produces — the
  // status effect depends on its identity.
  mockUseSession.mockReturnValue({
    data: { user: { ...user } },
    status: "authenticated",
    update,
  });
}

/** A fetch mock serving setup, status and delegation, enough for setup() to unlock. */
function makeFetchMock() {
  return vi.fn(async (url: string) => {
    if (url === VAULT_STATUS_PATH) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ setupRequired: true, vaultAutoLockMinutes: null }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

function callsTo(fetchMock: ReturnType<typeof makeFetchMock>, path: string): number {
  return fetchMock.mock.calls.filter(([url]) => url === path).length;
}

function statusCalls(fetchMock: ReturnType<typeof makeFetchMock>): number {
  return callsTo(fetchMock, VAULT_STATUS_PATH);
}

// The two root pollers that run while the vault is unlocked.
const POLLER_PATHS = [
  "/api/emergency-access/pending-confirmations",
  "/api/teams/pending-key-distributions",
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  update.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("VaultProvider — passkey-gated session, starting locked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    ["blocked", BLOCKED_USER],
    ["degraded", DEGRADED_USER],
  ])(
    "%s: skips the status fetch on every run, settles LOADING to LOCKED, arms no timer",
    async (_label, user) => {
      const fetchMock = makeFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      setSessionUser(user);

      const { result, rerender } = renderHook(() => useVault(), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);

      // A session update re-runs the status effect; it must skip again.
      setSessionUser(user);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      // Past both LOADING timers (10 s retry, 15 s fallback).
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });

      expect(statusCalls(fetchMock)).toBe(0);
      expect(update).not.toHaveBeenCalled();
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    },
  );

  it("allowed (passkeyBlocked false over blocking raw fields): fetches the status", async () => {
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setSessionUser(ALLOWED_USER);

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(statusCalls(fetchMock)).toBe(1);
    expect(result.current.status).toBe(VAULT_STATUS.SETUP_REQUIRED);
  });
});

describe("VaultProvider — session becomes passkey-gated while unlocked", () => {
  it.each([
    ["blocked", BLOCKED_USER],
    ["degraded", DEGRADED_USER],
  ])(
    "%s: keeps UNLOCKED, skips the status fetch, suspends the pollers, and the auto-lock still fires",
    async (_label, user) => {
      // Only the interval and the clock are faked: setup() runs real Web Crypto.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const fetchMock = makeFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      setSessionUser(ALLOWED_USER);

      const { result, rerender } = renderHook(() => useVault(), { wrapper });
      await act(async () => {
        await result.current.setup(PASSPHRASE);
      });
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      const callsBeforeBlock = statusCalls(fetchMock);
      // Positive control: unlocking started both pollers.
      for (const path of POLLER_PATHS) {
        expect(callsTo(fetchMock, path)).toBeGreaterThan(0);
      }

      setSessionUser(user);
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(statusCalls(fetchMock)).toBe(callsBeforeBlock);

      // Both pollers tick every 2 minutes; across 5 minutes, still unlocked,
      // neither may issue a call.
      const pollerCallsAtBlock = POLLER_PATHS.map((path) => callsTo(fetchMock, path));
      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
        await Promise.resolve();
      });
      expect(result.current.status).toBe(VAULT_STATUS.UNLOCKED);
      expect(POLLER_PATHS.map((path) => callsTo(fetchMock, path))).toEqual(pollerCallsAtBlock);

      // Past the default inactivity timeout: the auto-lock interval locks.
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(result.current.status).toBe(VAULT_STATUS.LOCKED);
    },
    60_000,
  );
});
