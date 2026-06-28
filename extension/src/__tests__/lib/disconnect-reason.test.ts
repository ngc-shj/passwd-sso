import { describe, it, expect, vi, beforeEach } from "vitest";
import { DISCONNECT_REASON_KEY, SESSION_KEY } from "../../lib/constants";

let mockStorage: Record<string, unknown>;

beforeEach(() => {
  mockStorage = {};
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: mockStorage[key] ?? undefined,
        })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(mockStorage, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete mockStorage[key];
        }),
      },
    },
  });
});

const {
  DISCONNECT_REASON,
  recordDisconnectReason,
  readDisconnectReason,
  clearDisconnectReason,
} = await import("../../lib/disconnect-reason");

describe("disconnect-reason", () => {
  it("round-trips a recorded reason", async () => {
    await recordDisconnectReason(DISCONNECT_REASON.EXPIRED);

    expect(await readDisconnectReason()).toBe(DISCONNECT_REASON.EXPIRED);
  });

  it("returns null when nothing has been recorded", async () => {
    expect(await readDisconnectReason()).toBeNull();
  });

  it("clears a recorded reason", async () => {
    await recordDisconnectReason(DISCONNECT_REASON.REVOKED);
    await clearDisconnectReason();

    expect(await readDisconnectReason()).toBeNull();
  });

  it("ignores an unknown stored value", async () => {
    mockStorage[DISCONNECT_REASON_KEY] = "garbage";

    expect(await readDisconnectReason()).toBeNull();
  });

  it("uses a key separate from the session state so it survives clearSession", async () => {
    // The reason must NOT live under SESSION_KEY, because clearSession() removes
    // SESSION_KEY when the token is dropped — the popup reads the reason after.
    expect(DISCONNECT_REASON_KEY).not.toBe(SESSION_KEY);

    await recordDisconnectReason(DISCONNECT_REASON.MANUAL);
    // Simulate clearSession() wiping only the session-state key.
    delete mockStorage[SESSION_KEY];

    expect(await readDisconnectReason()).toBe(DISCONNECT_REASON.MANUAL);
  });
});
