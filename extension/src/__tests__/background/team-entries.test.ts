import { describe, it, expect, vi, beforeEach } from "vitest";
import { createKeyedDecryptMock } from "../helpers/keyed-decrypt-mock";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";
import { EXT_ENTRY_TYPE } from "../../lib/constants";

const cryptoMocks = vi.hoisted(() => ({
  deriveWrappingKey: vi.fn().mockResolvedValue("wrap-key"),
  unwrapSecretKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deriveEncryptionKey: vi.fn().mockResolvedValue("enc-key"),
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
      sendMessage: vi.fn().mockResolvedValue({}),
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
}
function applyToken(token: string, expiresAt: number, cnfJkt: string): void {
  if (!bgModule) throw new Error("loadBackground() must be called before applyToken()");
  bgModule.applyToken(token, expiresAt, cnfJkt);
}

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, {}, (resp) => resolve(resp));
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
    installChromeMock();

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
});
