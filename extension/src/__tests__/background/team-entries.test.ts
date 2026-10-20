import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKeyedDecryptMock } from "../helpers/keyed-decrypt-mock";
import { holdDecrypt, holdFetch, holdNextCall } from "../helpers/deferred";
import { DEBOUNCE_MS } from "../../background/context-menu";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";
import { EXT_ENTRY_TYPE } from "../../lib/constants";

const cryptoMocks = vi.hoisted(() => ({
  deriveWrappingKey: vi.fn().mockResolvedValue("wrap-key"),
  unwrapSecretKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deriveEncryptionKey: vi.fn().mockResolvedValue("enc-key"),
  deriveAuthKeyBytes: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
  computeAuthHash: vi.fn().mockResolvedValue("fake-auth-hash"),
  verifyKey: vi.fn().mockResolvedValue(true),
  decryptData: vi.fn(),
  buildPersonalEntryAAD: vi.fn().mockReturnValue(new Uint8Array([1, 2])),
  hexDecode: vi.fn().mockReturnValue(new Uint8Array([0, 1])),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

vi.mock("../../lib/crypto", () => cryptoMocks);

/**
 * Positional `mockResolvedValueOnce` queues are forbidden for decryptData in
 * files that load background/index — UNLOCK_VAULT schedules a fire-and-forget
 * context-menu refresh on a real 200 ms debounce, and under CPU contention its
 * overview decrypt lands inside a test body and consumes a queued slot. Every
 * assertion downstream then reads the next test's value. This file used queues
 * and produced exactly that: four different tests in it failed across four
 * `scripts/pre-pr.sh` runs (`res.code` an object, `res.ok` false,
 * `res.password` null, `NO_PASSWORD` for `FETCH_FAILED`), while the file in
 * isolation passed 12/12 and the suite alone 6/6.
 *
 * Keying on the ciphertext makes the result independent of interleaving. See
 * helpers/keyed-decrypt-mock for the miss-path rationale.
 */
const PERSONAL_OVERVIEW_PLAINTEXT = JSON.stringify({
  title: "Example",
  username: "alice",
  urlHost: "example.com",
});
const TEAM_OVERVIEW_PLAINTEXT = JSON.stringify({
  title: "Team Entry",
  username: "bob",
  urlHost: "team.com",
});
const keyedDecrypt = createKeyedDecryptMock(cryptoMocks.decryptData);
const setDecryptedPlaintext = keyedDecrypt.set;

/**
 * Every overview ciphertext any endpoint in this file returns is mapped as a
 * default, because all of them are reachable by the fire-and-forget consumer,
 * and that consumer must never hit the throwing miss path:
 *   "11"            personal entry (single + list)
 *   "enc-overview"  team passwords LIST
 *   "ov-cipher"     team password by ID
 * The list and by-ID endpoints use different ciphertexts, which is easy to miss
 * — mapping only one of them left FETCH_PASSWORDS returning zero entries,
 * because the miss throws inside the per-entry decrypt and the entry is dropped.
 */
function installKeyedDecryptData(): void {
  keyedDecrypt.install({
    "11": PERSONAL_OVERVIEW_PLAINTEXT,
    "enc-overview": TEAM_OVERVIEW_PLAINTEXT,
    "ov-cipher": TEAM_OVERVIEW_PLAINTEXT,
  });
}

const teamCryptoMocks = vi.hoisted(() => ({
  deriveEcdhWrappingKey: vi.fn().mockResolvedValue("ecdh-wrap-key"),
  unwrapEcdhPrivateKey: vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
  importEcdhPrivateKey: vi.fn().mockResolvedValue("ecdh-private-key"),
  unwrapTeamKey: vi.fn().mockResolvedValue(new Uint8Array([40, 50, 60])),
  deriveTeamEncryptionKey: vi.fn().mockResolvedValue("team-enc-key"),
  unwrapItemKey: vi.fn().mockResolvedValue(new Uint8Array([70, 80, 90])),
  deriveItemEncryptionKey: vi.fn().mockResolvedValue("item-enc-key"),
  buildTeamEntryAAD: vi.fn().mockReturnValue(new Uint8Array([3, 4])),
  buildItemKeyWrapAAD: vi.fn().mockReturnValue(new Uint8Array([5, 6])),
}));

vi.mock("../../lib/crypto-team", () => teamCryptoMocks);

type MessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (resp: unknown) => void,
) => boolean | void;

let messageHandlers: MessageHandler[] = [];
let chromeMock: ReturnType<typeof installChromeMock> | null = null;

function installChromeMock() {
  messageHandlers = [];

  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: (fn: MessageHandler) => {
          messageHandlers.push(fn);
        },
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getContexts: vi.fn().mockResolvedValue([]),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    },
    offscreen: {
      createDocument: vi.fn().mockResolvedValue(undefined),
      Reason: { CLIPBOARD: "CLIPBOARD" },
    },
    alarms: {
      onAlarm: { addListener: vi.fn() },
      create: vi.fn(),
      clear: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      // A fill listener answers the fields it wrote; one means the fill landed.
      sendMessage: vi.fn().mockResolvedValue({ filled: 1 }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://github.com" }]),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
    contextMenus: {
      create: vi.fn((_props: unknown, cb?: () => void) => cb?.()),
      removeAll: vi.fn((cb?: () => void) => cb?.()),
      onClicked: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
    },
    storage: {
      local: {
        get: vi
          .fn()
          .mockResolvedValue({ serverUrl: "https://localhost:3000", autoLockMinutes: 15 }),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    commands: {
      onCommand: { addListener: vi.fn() },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

let bgModule: typeof import("../../background/index") | null = null;
async function loadBackground() {
  bgModule = await import("../../background/index");
  // Settle the module-load registration so it cannot land on the next test's chrome mock.
  await bgModule.tokenBridgeRegistration;
}
function applyToken(token: string, expiresAt: number, cnfJkt: string): void {
  if (!bgModule) throw new Error("loadBackground() must be called before applyToken()");
  bgModule.applyToken(token, expiresAt, cnfJkt);
}

// Every message this file drives through handleMessage is extension-page-only
// (UNLOCK_VAULT, FETCH_PASSWORDS, ...), so the default sender is an extension
// page — otherwise C5's sender gate refuses it before it does anything.
function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, { url: chrome.runtime.getURL("popup/index.html") }, (resp) => resolve(resp));
  });
}

// Vault unlock data that includes ECDH fields
const VAULT_UNLOCK_DATA = {
  userId: "user-1",
  accountSalt: "00",
  encryptedSecretKey: "aa",
  secretKeyIv: "bb",
  secretKeyAuthTag: "cc",
  verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
  encryptedEcdhPrivateKey: "dd",
  ecdhPrivateKeyIv: "ee",
  ecdhPrivateKeyAuthTag: "ff",
};

// Vault unlock data WITHOUT ECDH fields
const VAULT_UNLOCK_DATA_NO_ECDH = {
  userId: "user-1",
  accountSalt: "00",
  encryptedSecretKey: "aa",
  secretKeyIv: "bb",
  secretKeyAuthTag: "cc",
  verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
};

const MEMBER_KEY_RESPONSE = {
  encryptedTeamKey: "tk-cipher",
  teamKeyIv: "tk-iv",
  teamKeyAuthTag: "tk-tag",
  ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
  hkdfSalt: "aabb",
  keyVersion: 1,
  wrapVersion: 0,
};

function makeTeamEntry(
  id: string,
  entryType: string,
  overrides: Partial<{
    deletedAt: string | null;
    isArchived: boolean;
    teamKeyVersion: number;
    itemKeyVersion: number;
    encryptedItemKey: string;
    itemKeyIv: string;
    itemKeyAuthTag: string;
  }> = {},
) {
  return {
    id,
    entryType,
    encryptedOverview: "enc-overview",
    overviewIv: "ov-iv",
    overviewAuthTag: "ov-tag",
    teamKeyVersion: overrides.teamKeyVersion ?? 1,
    deletedAt: overrides.deletedAt ?? null,
    isArchived: overrides.isArchived ?? false,
    ...(overrides.itemKeyVersion != null
      ? {
          itemKeyVersion: overrides.itemKeyVersion,
          encryptedItemKey: overrides.encryptedItemKey ?? "ik-cipher",
          itemKeyIv: overrides.itemKeyIv ?? "ik-iv",
          itemKeyAuthTag: overrides.itemKeyAuthTag ?? "ik-tag",
        }
      : {}),
  };
}

const PERSONAL_ENTRY = {
  id: "pw-1",
  encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
  entryType: EXT_ENTRY_TYPE.LOGIN,
  aadVersion: 1,
};

describe("team entries in background", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installKeyedDecryptData();
    chromeMock = installChromeMock();

    fetchMock = vi.fn(async (url: string) => {
      if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
        return {
          ok: true,
          json: async () => ({
            token: "refreshed-tok",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            scope: ["passwords:read", "vault:unlock-data"],
          }),
        };
      }
      if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
        return { ok: true, status: 200, json: async () => ({ verified: true }) };
      }
      if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
        return { ok: true, json: async () => VAULT_UNLOCK_DATA };
      }
      if (url.includes("/member-key")) {
        return { ok: true, json: async () => MEMBER_KEY_RESPONSE };
      }
      if (url.includes(EXT_API_PATH.TEAMS) && url.match(/\/teams\/[^/]+\/passwords\/[^/]+$/)) {
        // Team password by ID (single entry)
        return {
          ok: true,
          json: async () => ({
            id: "team-pw-1",
            entryType: EXT_ENTRY_TYPE.LOGIN,
            encryptedBlob: "blob-cipher",
            blobIv: "blob-iv",
            blobAuthTag: "blob-tag",
            encryptedOverview: "ov-cipher",
            overviewIv: "ov-iv",
            overviewAuthTag: "ov-tag",
            teamKeyVersion: 1,
          }),
        };
      }
      if (url.includes(EXT_API_PATH.TEAMS) && url.match(/\/teams\/[^/]+\/passwords$/)) {
        // Team passwords list
        return {
          ok: true,
          json: async () => [
            makeTeamEntry("team-pw-1", EXT_ENTRY_TYPE.LOGIN),
          ],
        };
      }
      if (url.includes(EXT_API_PATH.TEAMS) && !url.includes("/")) {
        // Teams list — but this pattern is too broad, let's be more specific
        return {
          ok: true,
          json: async () => [{ id: "team-1", name: "Engineering" }],
        };
      }
      if (url.endsWith(EXT_API_PATH.TEAMS)) {
        return {
          ok: true,
          json: async () => [{ id: "team-1", name: "Engineering" }],
        };
      }
      if (url.includes(extApiPath.passwordById(""))) {
        return {
          ok: true,
          json: async () => ({
            id: "pw-1",
            encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
            encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
            aadVersion: 1,
            entryType: EXT_ENTRY_TYPE.LOGIN,
          }),
        };
      }
      if (url.includes(EXT_API_PATH.PASSWORDS)) {
        return {
          ok: true,
          json: async () => [PERSONAL_ENTRY],
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    vi.stubGlobal("fetch", fetchMock);
    await loadBackground();
  });

  afterEach(async () => {
    // Tear down this test's context-menu instance: cancel its pending debounce
    // and supersede any in-flight rebuild. vi.resetModules() leaves the old
    // instance alive, and its real-timer rebuild would otherwise fire during a
    // later test and call that test's chrome mock (found under parallel load).
    const { disableContextMenu } = await import("../../background/context-menu");
    await disableContextMenu();
  });

  async function unlockVault() {
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  }

  describe("ECDH key unwrapping on UNLOCK_VAULT", () => {
    it("unwraps ECDH private key when vault data includes ECDH fields", async () => {
      await unlockVault();
      expect(teamCryptoMocks.deriveEcdhWrappingKey).toHaveBeenCalled();
      expect(teamCryptoMocks.unwrapEcdhPrivateKey).toHaveBeenCalledWith(
        {
          ciphertext: "dd",
          iv: "ee",
          authTag: "ff",
        },
        "ecdh-wrap-key",
      );
    });

    it("silently skips ECDH when vault data lacks ECDH fields", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA_NO_ECDH };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [] };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      expect(teamCryptoMocks.deriveEcdhWrappingKey).not.toHaveBeenCalled();
    });
  });

  describe("FETCH_PASSWORDS with team entries", () => {
    it("merges personal and team entries", async () => {
      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; teamId?: string; teamName?: string }>;
      };

      expect(res.type).toBe("FETCH_PASSWORDS");
      expect(res.entries).toBeDefined();
      // Should have personal entries
      const personal = res.entries.filter((e) => !e.teamId);
      expect(personal.length).toBeGreaterThan(0);
      // Should have team entries with teamId and teamName
      const team = res.entries.filter((e) => e.teamId);
      expect(team.length).toBeGreaterThan(0);
      expect(team[0].teamId).toBe("team-1");
      expect(team[0].teamName).toBe("Engineering");
    });

    it("returns personal entries even when team fetch fails", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [PERSONAL_ENTRY] };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; teamId?: string }>;
      };

      const personal = res.entries.filter((e) => !e.teamId);
      expect(personal.length).toBeGreaterThan(0);
      const team = res.entries.filter((e) => e.teamId);
      expect(team).toHaveLength(0);
    });

    it("excludes deleted team entries", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA };
        }
        if (url.includes("/member-key")) {
          return { ok: true, json: async () => MEMBER_KEY_RESPONSE };
        }
        if (url.match(/\/teams\/[^/]+\/passwords$/)) {
          return {
            ok: true,
            json: async () => [
              makeTeamEntry("team-pw-deleted", EXT_ENTRY_TYPE.LOGIN, {
                deletedAt: "2025-01-01T00:00:00Z",
              }),
              makeTeamEntry("team-pw-archived", EXT_ENTRY_TYPE.LOGIN, {
                isArchived: true,
              }),
              makeTeamEntry("team-pw-active", EXT_ENTRY_TYPE.LOGIN),
            ],
          };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return {
            ok: true,
            json: async () => [{ id: "team-1", name: "Engineering" }],
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; teamId?: string }>;
      };
      const teamEntries = res.entries.filter((e) => e.teamId);
      // Only the active entry should remain
      expect(teamEntries).toHaveLength(1);
      expect(teamEntries[0].id).toBe("team-pw-active");
    });

    it("excludes SECURE_NOTE team entries", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA };
        }
        if (url.includes("/member-key")) {
          return { ok: true, json: async () => MEMBER_KEY_RESPONSE };
        }
        if (url.match(/\/teams\/[^/]+\/passwords$/)) {
          return {
            ok: true,
            json: async () => [
              makeTeamEntry("team-note", "SECURE_NOTE"),
              makeTeamEntry("team-login", EXT_ENTRY_TYPE.LOGIN),
            ],
          };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return {
            ok: true,
            json: async () => [{ id: "team-1", name: "Dev" }],
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; entryType: string; teamId?: string }>;
      };
      const teamEntries = res.entries.filter((e) => e.teamId);
      expect(teamEntries).toHaveLength(1);
      expect(teamEntries[0].entryType).toBe(EXT_ENTRY_TYPE.LOGIN);
    });

    it("returns empty team entries when ECDH key is not available", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA_NO_ECDH };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [PERSONAL_ENTRY] };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return {
            ok: true,
            json: async () => [{ id: "team-1", name: "Engineering" }],
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; teamId?: string }>;
      };
      // Should still have personal entries
      const personal = res.entries.filter((e) => !e.teamId);
      expect(personal.length).toBeGreaterThan(0);
      // No team entries (no ECDH key)
      const team = res.entries.filter((e) => e.teamId);
      expect(team).toHaveLength(0);
    });

    // teamId is part of the menu view compared by
    // setCachedEntries, but the parametrized case for the other fields lives
    // in background.test.ts (no team harness there) — this is the one case
    // that needs this file's team fetch chain.
    it("rebuilds the context menu when the same entry's teamId changes", async () => {
      // Every rebuild runs behind the menu's DEBOUNCE_MS timer. Fake the timers
      // for the whole cell, so no real debounce from an earlier step can fire
      // inside the window this cell observes, and every wait is the debounce
      // itself rather than a wall-clock budget a loaded machine can overrun.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        // Clear first, then wait for the UNLOCK rebuild's last item: a gate that
        // the earlier calls already satisfy would wait for nothing.
        chromeMock!.contextMenus.create.mockClear();
        await unlockVault();
        // waitFor advances the fake clock as it polls.
        await vi.waitFor(() => {
          const ids = chromeMock!.contextMenus.create.mock.calls.map((c: unknown[]) => (c[0] as { id: string }).id);
          expect(ids).toContain("psso-open-popup");
        });
        await sendMessage({ type: "FETCH_PASSWORDS" });
        // Run out this cell's own debounces scheduled so far (earlier tests'
        // instances are torn down in afterEach).
        await vi.runAllTimersAsync();
        chromeMock!.contextMenus.removeAll.mockClear();

        // Same team-pw-1 entry, same team passwords list, but the teams list
        // now reports it under a different team id — id/title/username/urlHost
        // unchanged, teamId alone differs.
        fetchMock.mockImplementation(async (url: string) => {
          if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
            return {
              ok: true,
              json: async () => ({
                token: "refreshed-tok",
                expiresAt: new Date(Date.now() + 900_000).toISOString(),
                scope: ["passwords:read", "vault:unlock-data"],
              }),
            };
          }
          if (url.includes("/member-key")) {
            return { ok: true, json: async () => MEMBER_KEY_RESPONSE };
          }
          if (url.match(/\/teams\/[^/]+\/passwords$/)) {
            return { ok: true, json: async () => [makeTeamEntry("team-pw-1", EXT_ENTRY_TYPE.LOGIN)] };
          }
          if (url.endsWith(EXT_API_PATH.TEAMS)) {
            return { ok: true, json: async () => [{ id: "team-2", name: "Engineering" }] };
          }
          if (url.includes(EXT_API_PATH.PASSWORDS)) {
            return { ok: true, json: async () => [PERSONAL_ENTRY] };
          }
          return { ok: false, json: async () => ({}) };
        });

        const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
          entries: Array<{ id: string; teamId?: string }>;
        };
        expect(res.entries.find((e) => e.id === "team-pw-1")?.teamId).toBe("team-2");

        // The rebuild waits out the debounce: not one millisecond early, then due.
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
        expect(chromeMock!.contextMenus.removeAll).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(chromeMock!.contextMenus.removeAll).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("COPY_PASSWORD with teamId", () => {
    it("routes to team API when teamId is present", async () => {
      await unlockVault();

      setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));

      const res = (await sendMessage({
        type: "COPY_PASSWORD",
        entryId: "team-pw-1",
        teamId: "team-1",
      })) as { type: string; password: string | null };

      expect(res.type).toBe("COPY_PASSWORD");
      expect(res.password).toBe("team-secret");
    });

    // fetchAndDecryptTeamBlob parses two decrypted team plaintexts. Before those
    // parses were narrowed, a SyntaxError propagated to the caller's catch, where
    // normalizeErrorCode returned err.message verbatim — and V8 embeds a window of
    // the parse INPUT in that message. The caller renders it as a popup toast.
    it("does not surface decrypted team plaintext when the blob is not valid JSON", async () => {
      await unlockVault();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      setDecryptedPlaintext(
        "blob-cipher",
        '{"username":"bob","password":S3cr3t-Passw0rd-VeryLong}',
      );

      const res = (await sendMessage({
        type: "COPY_PASSWORD",
        entryId: "team-pw-1",
        teamId: "team-1",
      })) as { type: string; password: string | null; error?: string };

      expect(res.password).toBeNull();
      // A mapped constant, not a reflected message.
      expect(res.error).toBe("FETCH_FAILED");
      const surfaced = JSON.stringify(res) + warn.mock.calls.flat().join(" ");
      expect(surfaced).not.toContain("S3cr3t");
      expect(surfaced).not.toContain("SyntaxError");
      warn.mockRestore();
    });

    it("returns error when team entry fetch fails", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA };
        }
        if (url.includes("/member-key")) {
          return { ok: true, json: async () => MEMBER_KEY_RESPONSE };
        }
        if (url.match(/\/teams\/[^/]+\/passwords\/[^/]+$/)) {
          return { ok: false, json: async () => ({}) };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({
        type: "COPY_PASSWORD",
        entryId: "team-pw-1",
        teamId: "team-1",
      })) as { type: string; password: string | null; error?: string };

      expect(res.password).toBeNull();
      expect(res.error).toBe("FETCH_FAILED");
    });
  });

  describe("COPY_TOTP with teamId", () => {
    it("routes to team API when teamId is present", async () => {
      await unlockVault();

      setDecryptedPlaintext(
        "blob-cipher",
        JSON.stringify({
          password: "pw",
          totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
        }),
      );

      const res = (await sendMessage({
        type: "COPY_TOTP",
        entryId: "team-pw-1",
        teamId: "team-1",
      })) as { type: string; code: string | null; error?: string };

      expect(res.type).toBe("COPY_TOTP");
      // Should have a code (6-digit TOTP)
      expect(res.code).toMatch(/^\d{6}$/);
    });
  });

  describe("AUTOFILL with teamId", () => {
    it("passes teamId to performAutofillForEntry", async () => {
      await unlockVault();

      setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "pw", username: "bob" }));

      const res = (await sendMessage({
        type: "AUTOFILL",
        entryId: "team-pw-1",
        tabId: 1,
        teamId: "team-1",
        expectedOrigin: "https://example.com",
      })) as { type: string; ok: boolean };

      expect(res.type).toBe("AUTOFILL");
      expect(res.ok).toBe(true);
    });
  });

  describe("clearVault security", () => {
    it("clears team key cache on LOCK_VAULT", async () => {
      await unlockVault();

      // Trigger FETCH to populate team key cache
      await sendMessage({ type: "FETCH_PASSWORDS" });

      // Lock vault
      await sendMessage({ type: "LOCK_VAULT" });

      // Fetch should return empty since vault is locked
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: null;
        error?: string;
      };
      expect(res.entries).toBeNull();
      expect(res.error).toBe("VAULT_LOCKED");
    });
  });

  describe("entry type filtering in personal entries", () => {
    it("excludes SECURE_NOTE from personal entries", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return { ok: true, json: async () => VAULT_UNLOCK_DATA };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-note",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: "SECURE_NOTE",
                aadVersion: 1,
              },
              {
                id: "pw-login",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
              {
                id: "pw-card",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
                aadVersion: 1,
              },
              {
                id: "pw-id",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.IDENTITY,
                aadVersion: 1,
              },
            ],
          };
        }
        if (url.endsWith(EXT_API_PATH.TEAMS)) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      });

      await unlockVault();
      const res = (await sendMessage({ type: "FETCH_PASSWORDS" })) as {
        type: string;
        entries: Array<{ id: string; entryType: string }>;
      };

      const ids = res.entries.map((e) => e.id);
      expect(ids).not.toContain("pw-note");
      expect(ids).toContain("pw-login");
      expect(ids).toContain("pw-card");
      expect(ids).toContain("pw-id");
    });
  });
  // ── #885: team keys and team entries across a lock ──
  // Holds are one-shot and armed after the unlock settled. The active tab is
  // URL-less here, so no context-menu rebuild reads entries (or caches a team
  // key) behind a test's back.
  describe("vault epoch (#885)", () => {
    beforeEach(() => {
      chromeMock!.tabs.query.mockResolvedValue([{ id: 1, url: undefined }]);
    });

    const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS * 2));
    const fetchCalls = (pathPart: string) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes(pathPart)).length;
    const memberKeyFetches = () => fetchCalls("/member-key");
    const unlockAgain = () => sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    const lock = () => sendMessage({ type: "LOCK_VAULT" });
    const teamEntryIds = (res: unknown) =>
      ((res as { entries: Array<{ id: string; teamId?: string }> | null }).entries ?? [])
        .filter((e) => e.teamId)
        .map((e) => e.id);

    async function unlockAndSettle(): Promise<void> {
      await unlockVault();
      await vi.waitFor(() => expect(fetchCalls(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)).toBeGreaterThan(0));
      await settle();
    }

    // Serve unlock data without the ECDH fields from now on.
    function serveUnlockWithoutEcdh(): void {
      const base = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
      fetchMock.mockImplementation(async (url: string) =>
        url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)
          ? { ok: true, json: async () => VAULT_UNLOCK_DATA_NO_ECDH }
          : base(url),
      );
    }

    // A lock, or a lock and a fresh unlock, before the parked operation
    // resumes. Only the second tells an epoch check from an "is the vault
    // unlocked now?" check: after it the vault is unlocked, just not for this
    // operation.
    const INTERRUPTIONS: Array<[string, () => Promise<void>]> = [
      ["a lock", async () => {
        await lock();
      }],
      ["a lock and re-unlock", async () => {
        await lock();
        expect(await unlockAgain()).toEqual({ type: "UNLOCK_VAULT", ok: true });
      }],
    ];

    // A2: fetchAllTeamEntries
    it.each(INTERRUPTIONS)("FETCH_PASSWORDS answers VAULT_LOCKED after %s during a team overview decrypt (A2)", async (_name, interrupt) => {
      await unlockAndSettle();
      const hold = holdDecrypt(cryptoMocks.decryptData, "enc-overview");
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      await interrupt();
      hold.release();

      expect(await pending).toEqual({ type: "FETCH_PASSWORDS", entries: null, error: "VAULT_LOCKED" });
    });

    it("positive control (A2): released without a lock it answers the team entry", async () => {
      await unlockAndSettle();
      const hold = holdDecrypt(cryptoMocks.decryptData, "enc-overview");
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      hold.release();

      expect(teamEntryIds(await pending)).toEqual(["team-pw-1"]);
    });

    // A3: getTeamEncryptionKey. A key derived across a lock and re-unlock must
    // not land in the cache: the next fetch would reuse it without asking the
    // server for the member key.
    it("a lock during the team-key derive caches no key the next unlock reuses (A3)", async () => {
      await unlockAndSettle();
      const hold = holdNextCall(teamCryptoMocks.deriveTeamEncryptionKey);
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      await lock();
      expect(await unlockAgain()).toEqual({ type: "UNLOCK_VAULT", ok: true });
      hold.release();
      expect(await pending).toEqual({ type: "FETCH_PASSWORDS", entries: null, error: "VAULT_LOCKED" });
      const before = memberKeyFetches();

      const res = await sendMessage({ type: "FETCH_PASSWORDS" });

      expect(teamEntryIds(res)).toEqual(["team-pw-1"]);
      expect(memberKeyFetches() - before).toBe(1);
    });

    it("positive control (A3): a key derived without a lock is cached and reused", async () => {
      await unlockAndSettle();
      const hold = holdNextCall(teamCryptoMocks.deriveTeamEncryptionKey);
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      hold.release();
      expect(teamEntryIds(await pending)).toEqual(["team-pw-1"]);
      const before = memberKeyFetches();

      const res = await sendMessage({ type: "FETCH_PASSWORDS" });

      expect(teamEntryIds(res)).toEqual(["team-pw-1"]);
      expect(memberKeyFetches() - before).toBe(0);
    });

    // C3 / FR4: the retry after a failed team decrypt drops the key that
    // getTeamEncryptionKey stored, so the retry asks for the member key again.
    it("a failed team decrypt drops the cached team key and the retry refetches it (C3)", async () => {
      await unlockAndSettle();
      await sendMessage({ type: "FETCH_PASSWORDS" });
      const hold = holdDecrypt(cryptoMocks.decryptData, "enc-overview");
      const before = memberKeyFetches();
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      hold.fail(new Error("OperationError"));

      expect(teamEntryIds(await pending)).toEqual(["team-pw-1"]);
      expect(memberKeyFetches() - before).toBe(1);
    });

    it("positive control (C3): without a failed decrypt the cached team key is reused", async () => {
      await unlockAndSettle();
      await sendMessage({ type: "FETCH_PASSWORDS" });
      const hold = holdDecrypt(cryptoMocks.decryptData, "enc-overview");
      const before = memberKeyFetches();
      const pending = sendMessage({ type: "FETCH_PASSWORDS" });
      await hold.reached;
      hold.release();

      expect(teamEntryIds(await pending)).toEqual(["team-pw-1"]);
      expect(memberKeyFetches() - before).toBe(0);
    });

    // A5: fetchAndDecryptTeamBlob
    it.each(INTERRUPTIONS)("team COPY_PASSWORD answers VAULT_LOCKED with no password after %s during the decrypt (A5)", async (_name, interrupt) => {
      await unlockAndSettle();
      setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));
      const hold = holdDecrypt(cryptoMocks.decryptData, "ov-cipher");
      const pending = sendMessage({ type: "COPY_PASSWORD", entryId: "team-pw-1", teamId: "team-1" });
      await hold.reached;
      await interrupt();
      hold.release();

      expect(await pending).toEqual({ type: "COPY_PASSWORD", password: null, error: "VAULT_LOCKED" });
    });

    it("positive control (A5): released without a lock it answers the team password", async () => {
      await unlockAndSettle();
      setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));
      const hold = holdDecrypt(cryptoMocks.decryptData, "ov-cipher");
      const pending = sendMessage({ type: "COPY_PASSWORD", entryId: "team-pw-1", teamId: "team-1" });
      await hold.reached;
      hold.release();

      expect(await pending).toEqual({ type: "COPY_PASSWORD", password: "team-secret" });
    });

    // A lock during the team blob fetch leaves no team key to find (clearVault
    // dropped the ECDH key and the team-key cache). That is "locked", not
    // "the entry could not be fetched".
    const TEAM_BLOB_PATH = extApiPath.teamPasswordById("team-1", "team-pw-1");

    // Serve the team entry by id as an item-key (itemKeyVersion 1) entry.
    function serveItemKeyTeamBlob(): void {
      const base = fetchMock.getMockImplementation() as (url: string) => Promise<{ json: () => Promise<unknown> }>;
      fetchMock.mockImplementation(async (url: string) => {
        if (!url.endsWith(TEAM_BLOB_PATH)) return base(url);
        const res = await base(url);
        const body = (await res.json()) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({
            ...body,
            itemKeyVersion: 1,
            encryptedItemKey: "ik-cipher",
            itemKeyIv: "ik-iv",
            itemKeyAuthTag: "ik-tag",
          }),
        };
      });
    }

    describe.each([
      ["a team-key entry", () => {}],
      ["an item-key entry", serveItemKeyTeamBlob],
    ])("team COPY_PASSWORD, %s", (_name, serve) => {
      it("answers VAULT_LOCKED, not FETCH_FAILED, when the vault locks during the team blob fetch", async () => {
        serve();
        await unlockAndSettle();
        setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));
        const hold = holdFetch(fetchMock, TEAM_BLOB_PATH);
        const pending = sendMessage({ type: "COPY_PASSWORD", entryId: "team-pw-1", teamId: "team-1" });
        await hold.reached;
        await lock();
        hold.release();

        expect(await pending).toEqual({ type: "COPY_PASSWORD", password: null, error: "VAULT_LOCKED" });
      });

      it("positive control: released without a lock it answers the team password", async () => {
        serve();
        await unlockAndSettle();
        setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));
        const hold = holdFetch(fetchMock, TEAM_BLOB_PATH);
        const pending = sendMessage({ type: "COPY_PASSWORD", entryId: "team-pw-1", teamId: "team-1" });
        await hold.reached;
        hold.release();

        expect(await pending).toEqual({ type: "COPY_PASSWORD", password: "team-secret" });
      });
    });

    // The context menu is the one fill path whose failure shows as a per-tab
    // badge; a lock during a team fill must not raise one (the locked badge is
    // already up, and the failure badge would cover it).
    describe("context-menu team fill", () => {
      const TEAM_UUID = "b0000000-0000-0000-0000-000000000001";
      const ENTRY_UUID = "c0000000-0000-0000-0000-000000000001";
      const menuBlobPath = extApiPath.teamPasswordById(TEAM_UUID, ENTRY_UUID);
      const click = () => {
        const [[onClicked]] = chromeMock!.contextMenus.onClicked.addListener.mock.calls as Array<
          [(info: Record<string, unknown>, tab: Record<string, unknown>) => void]
        >;
        onClicked(
          { menuItemId: `psso-login-${TEAM_UUID}:${ENTRY_UUID}`, frameUrl: "https://team.com/login", frameId: 0 },
          { id: 1, url: "https://team.com/login" },
        );
      };
      const failureBadges = () =>
        (chromeMock!.action.setBadgeText.mock.calls as unknown[][]).filter(([arg]) => {
          const { text, tabId } = arg as { text?: string; tabId?: number };
          return text === "!" && tabId === 1;
        });
      const flush = () => new Promise((r) => setTimeout(r, 20));

      it("a lock during the team blob fetch raises no failure badge", async () => {
        await unlockAndSettle();
        const hold = holdFetch(fetchMock, menuBlobPath);
        click();
        await hold.reached;
        await lock();
        hold.release();
        await flush();

        expect(failureBadges()).toEqual([]);
      });

      it("positive control: a failed team blob fetch at the same point raises the failure badge", async () => {
        await unlockAndSettle();
        const hold = holdNextCall(fetchMock, (url: string) => String(url).endsWith(menuBlobPath), {
          result: () => ({ ok: false, json: async () => ({}) }),
        });
        click();
        await hold.reached;
        hold.release();
        await flush();

        expect(failureBadges()).toHaveLength(1);
      });
    });

    // A stale cached team key is dropped and refetched once per key version,
    // not once per entry that fails to decrypt under it.
    it("two undecryptable entries under one cached team key refetch the member key once", async () => {
      await unlockAndSettle();
      await sendMessage({ type: "FETCH_PASSWORDS" });
      const base = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
      // Unmapped ciphertexts: the keyed decrypt mock throws for both.
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith(extApiPath.teamPasswords("team-1"))
          ? {
              ok: true,
              json: async () => [
                { ...makeTeamEntry("team-bad-1", EXT_ENTRY_TYPE.LOGIN), encryptedOverview: "bad-ov-1" },
                { ...makeTeamEntry("team-bad-2", EXT_ENTRY_TYPE.LOGIN), encryptedOverview: "bad-ov-2" },
              ],
            }
          : base(url),
      );
      const before = memberKeyFetches();

      const res = await sendMessage({ type: "FETCH_PASSWORDS" });

      expect(teamEntryIds(res)).toEqual([]);
      expect(memberKeyFetches() - before).toBe(1);
    });

    // A18 (C2): the ECDH unwrap is the unlock's last key-state commit.
    it("an unlock locked during its ECDH unwrap leaves no ECDH key for a later unlock without one (A18)", async () => {
      applyToken("t", Date.now() + 60_000, "");
      const hold = holdNextCall(teamCryptoMocks.unwrapEcdhPrivateKey);
      const pending = unlockAgain();
      await hold.reached;
      await lock();
      hold.release();
      expect(await pending).toEqual({ type: "UNLOCK_VAULT", ok: false, error: "VAULT_LOCKED" });

      serveUnlockWithoutEcdh();
      expect(await unlockAgain()).toEqual({ type: "UNLOCK_VAULT", ok: true });

      expect(teamEntryIds(await sendMessage({ type: "FETCH_PASSWORDS" }))).toEqual([]);
    });

    it("an unlock whose ECDH unwrap fails after a lock does not clear the next unlock's ECDH key (A18)", async () => {
      applyToken("t", Date.now() + 60_000, "");
      const hold = holdNextCall(teamCryptoMocks.unwrapEcdhPrivateKey);
      const stale = unlockAgain();
      await hold.reached;
      await lock();
      expect(await unlockAgain()).toEqual({ type: "UNLOCK_VAULT", ok: true });
      hold.fail(new Error("OperationError"));
      expect(await stale).toEqual({ type: "UNLOCK_VAULT", ok: false, error: "VAULT_LOCKED" });

      expect(teamEntryIds(await sendMessage({ type: "FETCH_PASSWORDS" }))).toEqual(["team-pw-1"]);
    });

    it("positive control (A18): an ECDH unwrap released without a lock gives team entries", async () => {
      applyToken("t", Date.now() + 60_000, "");
      const hold = holdNextCall(teamCryptoMocks.unwrapEcdhPrivateKey);
      const pending = unlockAgain();
      await hold.reached;
      hold.release();
      expect(await pending).toEqual({ type: "UNLOCK_VAULT", ok: true });

      expect(teamEntryIds(await sendMessage({ type: "FETCH_PASSWORDS" }))).toEqual(["team-pw-1"]);
    });

    // C7: the shared entry access the autofill and HTTP-auth paths call.
    describe("fetchAndDecryptEntry, team path", () => {
      const TEAM_BLOB_PATH = extApiPath.teamPasswordById("team-1", "team-pw-1");
      const currentEpoch = async () => (await import("../../background/vault-epoch")).currentVaultEpoch();

      it("returns the team entry's decrypted blob, overview and type", async () => {
        await unlockAndSettle();
        setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret", url: "https://team.com" }));

        expect(await bgModule!.fetchAndDecryptEntry("team-pw-1", "team-1", await currentEpoch())).toEqual({
          ok: true,
          blob: { password: "team-secret", url: "https://team.com" },
          overview: JSON.parse(TEAM_OVERVIEW_PLAINTEXT),
          entryType: EXT_ENTRY_TYPE.LOGIN,
        });
      });

      function failTeamBlobFetch(): void {
        const base = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
        fetchMock.mockImplementation(async (url: string) =>
          url.endsWith(TEAM_BLOB_PATH) ? { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) } : base(url),
        );
      }

      it("answers FETCH_FAILED when the team entry fetch fails", async () => {
        await unlockAndSettle();
        failTeamBlobFetch();

        expect(await bgModule!.fetchAndDecryptEntry("team-pw-1", "team-1", await currentEpoch())).toEqual({
          ok: false,
          error: "FETCH_FAILED",
        });
      });

      it.each(INTERRUPTIONS)("answers VAULT_LOCKED, not FETCH_FAILED, after %s during a failing team fetch", async (_name, interrupt) => {
        await unlockAndSettle();
        failTeamBlobFetch();
        const epoch = await currentEpoch();
        const hold = holdFetch(fetchMock, TEAM_BLOB_PATH);
        const pending = bgModule!.fetchAndDecryptEntry("team-pw-1", "team-1", epoch);
        await hold.reached;
        await interrupt();
        hold.release();

        expect(await pending).toEqual({ ok: false, error: "VAULT_LOCKED" });
      });

      it.each(INTERRUPTIONS)("answers VAULT_LOCKED after %s during the team blob fetch", async (_name, interrupt) => {
        await unlockAndSettle();
        setDecryptedPlaintext("blob-cipher", JSON.stringify({ password: "team-secret" }));
        const epoch = await currentEpoch();
        const hold = holdFetch(fetchMock, TEAM_BLOB_PATH);
        const pending = bgModule!.fetchAndDecryptEntry("team-pw-1", "team-1", epoch);
        await hold.reached;
        await interrupt();
        hold.release();

        expect(await pending).toEqual({ ok: false, error: "VAULT_LOCKED" });
      });
    });
  });
});
