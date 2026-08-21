// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFetchApi, mockDecryptData } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
}));

vi.mock("@/lib/url-helpers", () => ({ fetchApi: mockFetchApi }));
vi.mock("@/lib/crypto/crypto-client", () => ({ decryptData: mockDecryptData }));
vi.mock("@/lib/crypto/crypto-aad", () => ({ buildTeamEntryAAD: () => "aad" }));

import { buildTeamGetDetail } from "./build-team-get-detail";

/**
 * The re-prompt flag is the client-side control deciding whether a decrypted
 * team secret may leave the vault without a fresh passphrase. This builder used
 * to omit it from the InlineDetailData it returns, and every consumer coalesced
 * the absence to `false` (`data.requireReprompt ?? false`), so the control was
 * off for every team entry regardless of how it was configured — while the API
 * had been sending the flag all along.
 */
describe("buildTeamGetDetail — requireReprompt propagation", () => {
  const deps = { getEntryDecryptionKey: vi.fn().mockResolvedValue({} as CryptoKey) };

  function respondWith(body: Record<string, unknown>) {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({
        encryptedBlob: "c",
        blobIv: "i",
        blobAuthTag: "a",
        itemKeyVersion: 1,
        teamKeyVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...body,
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptData.mockResolvedValue(JSON.stringify({ title: "t", password: "p" }));
  });

  it("carries a true flag through to the detail the guard reads", async () => {
    // Reds against the pre-fix builder, which returned no requireReprompt key at
    // all: `data.requireReprompt ?? false` then read `undefined` as "no prompt".
    respondWith({ requireReprompt: true });

    const detail = await buildTeamGetDetail("team-1", { id: "e1" }, deps)();

    expect(detail.requireReprompt).toBe(true);
  });

  it("carries a false flag through without inventing a prompt", async () => {
    // The allow side: fail-closed must not mean "prompt on every team copy".
    respondWith({ requireReprompt: false });

    const detail = await buildTeamGetDetail("team-1", { id: "e1" }, deps)();

    expect(detail.requireReprompt).toBe(false);
  });

  it("fails closed when the server omits the flag", async () => {
    // A future `select:` narrowing on the team route would otherwise silently
    // disable the control again, exactly as the dropped field did.
    respondWith({});

    const detail = await buildTeamGetDetail("team-1", { id: "e1" }, deps)();

    expect(detail.requireReprompt).toBe(true);
  });
});
