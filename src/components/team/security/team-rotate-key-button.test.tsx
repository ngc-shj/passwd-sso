// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const SENTINEL_NEWTEAMKEY_BYTE = 0xab;
const SENTINEL_RAW_ITEMKEY_BYTE = 0xcd;

const {
  mockFetch,
  mockToast,
  generateTeamKeyMock,
  unwrapItemKeyMock,
  wrapItemKeyMock,
  createEscrowMock,
  deriveTeamKeyMock,
  rawItemKeysSnapshot,
  newTeamKeysSnapshot,
} = vi.hoisted(() => {
  const rawSnap: { refs: Uint8Array[] } = { refs: [] };
  const teamKeySnap: { refs: Uint8Array[] } = { refs: [] };
  return {
    mockFetch: vi.fn(),
    mockToast: { error: vi.fn(), success: vi.fn() },
    generateTeamKeyMock: vi.fn(() => {
      const buf = new Uint8Array(32).fill(0xab);
      teamKeySnap.refs.push(buf);
      return buf;
    }),
    unwrapItemKeyMock: vi.fn(async () => {
      const buf = new Uint8Array(32).fill(0xcd);
      rawSnap.refs.push(buf);
      return buf;
    }),
    wrapItemKeyMock: vi.fn(async () => ({
      ciphertext: "ct",
      iv: "iv",
      authTag: "at",
    })),
    createEscrowMock: vi.fn(async () => ({
      encryptedTeamKey: "ek",
      teamKeyIv: "tkiv",
      teamKeyAuthTag: "tkat",
      ephemeralPublicKey: "epk",
      hkdfSalt: "salt",
      keyVersion: 2,
      wrapVersion: 1,
    })),
    deriveTeamKeyMock: vi.fn(async () => ({} as CryptoKey)),
    rawItemKeysSnapshot: rawSnap,
    newTeamKeysSnapshot: teamKeySnap,
  };
});

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-core", () => ({
  useTeamVault: () => ({
    getTeamKeyInfo: vi.fn(async () => ({ key: {} as CryptoKey, keyVersion: 1 })),
    invalidateTeamKey: vi.fn(),
  }),
}));

vi.mock("@/lib/crypto/crypto-team", () => ({
  generateTeamSymmetricKey: () => generateTeamKeyMock(),
  createTeamKeyEscrow: (...args: unknown[]) => createEscrowMock(...args),
  encryptTeamEntry: vi.fn(async () => ({ ciphertext: "c", iv: "i", authTag: "a" })),
  decryptTeamEntry: vi.fn(async () => "{}"),
  wrapItemKey: (...args: unknown[]) => wrapItemKeyMock(...args),
  unwrapItemKey: (...args: unknown[]) => unwrapItemKeyMock(...args),
  deriveTeamEncryptionKey: (...args: unknown[]) => deriveTeamKeyMock(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: vi.fn(() => "team-aad"),
  buildItemKeyWrapAAD: vi.fn(() => "item-key-aad"),
}));

import { TeamRotateKeyButton } from "./team-rotate-key-button";

const ENTRIES = [
  {
    id: "entry-1",
    encryptedBlob: "ebl",
    blobIv: "bi",
    blobAuthTag: "ba",
    encryptedOverview: "eov",
    overviewIv: "oi",
    overviewAuthTag: "oa",
    teamKeyVersion: 1,
    itemKeyVersion: 1,
    encryptedItemKey: "eik",
    itemKeyIv: "iki",
    itemKeyAuthTag: "ika",
    aadVersion: 1,
  },
  {
    id: "entry-2",
    encryptedBlob: "ebl2",
    blobIv: "bi2",
    blobAuthTag: "ba2",
    encryptedOverview: "eov2",
    overviewIv: "oi2",
    overviewAuthTag: "oa2",
    teamKeyVersion: 1,
    itemKeyVersion: 1,
    encryptedItemKey: "eik2",
    itemKeyIv: "iki2",
    itemKeyAuthTag: "ika2",
    aadVersion: 1,
  },
];

const MEMBERS = [{ userId: "u1", ecdhPublicKey: "pk1" }];

function setupRotateFetch(opts?: { rotateOk?: boolean; rotateStatus?: number }) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("rotate-key/data") || url.includes("rotate-key-data")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            teamKeyVersion: 1,
            entries: ENTRIES,
            members: MEMBERS,
          }),
      });
    }
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: opts?.rotateOk ?? true,
        status: opts?.rotateStatus ?? 200,
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function openAndConfirm() {
  const trigger = screen.getByText("rotateKeyButton");
  await act(async () => {
    fireEvent.click(trigger);
  });
  // Type "rotate" in the confirm input
  const input = await screen.findByPlaceholderText("rotateKeyTypePlaceholder");
  fireEvent.change(input, { target: { value: "rotate" } });
  const confirmBtn = screen.getByText("rotateKeyConfirm");
  await act(async () => {
    fireEvent.click(confirmBtn);
  });
}

describe("TeamRotateKeyButton — §Sec-1 crypto invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rawItemKeysSnapshot.refs.length = 0;
    newTeamKeysSnapshot.refs.length = 0;
  });

  it("renders the rotate-key trigger button", () => {
    render(<TeamRotateKeyButton teamId="team-1" />);
    expect(screen.getByText("rotateKeyButton")).toBeInTheDocument();
  });

  it("zeroes EACH rawItemKey after re-wrap (per-entry invariant)", async () => {
    setupRotateFetch();
    render(<TeamRotateKeyButton teamId="team-1" onSuccess={vi.fn()} />);
    await openAndConfirm();

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalled();
    });

    // Every rawItemKey buffer used in unwrap should be zeroed afterwards
    expect(rawItemKeysSnapshot.refs.length).toBe(ENTRIES.length);
    for (const buf of rawItemKeysSnapshot.refs) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }
  });

  it("zeroes newTeamKeyBytes after member-key rewrapping", async () => {
    setupRotateFetch();
    render(<TeamRotateKeyButton teamId="team-1" />);
    await openAndConfirm();

    await waitFor(() => {
      expect(createEscrowMock).toHaveBeenCalled();
    });

    expect(newTeamKeysSnapshot.refs.length).toBe(1);
    expect(newTeamKeysSnapshot.refs[0].every((b) => b === 0)).toBe(true);
  });

  it("does not include raw new TeamKey bytes in POST body", async () => {
    setupRotateFetch();
    render(<TeamRotateKeyButton teamId="team-1" />);
    await openAndConfirm();

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
    });

    const postCall = mockFetch.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    )!;
    const body = (postCall[1] as RequestInit).body as string;
    // Sentinel hex: 32 bytes of 0xAB → "ab".repeat(32)
    const sentinelHex = "ab".repeat(32);
    expect(body.toLowerCase()).not.toContain(sentinelHex);
    // Also ensure raw item-key sentinel hex is absent
    const itemKeySentinelHex = "cd".repeat(32);
    expect(body.toLowerCase()).not.toContain(itemKeySentinelHex);
  });

  it("calls wrapItemKey with shape-checked args (Uint8Array key, AAD string)", async () => {
    setupRotateFetch();
    render(<TeamRotateKeyButton teamId="team-1" />);
    await openAndConfirm();

    await waitFor(() => {
      expect(wrapItemKeyMock).toHaveBeenCalled();
    });

    // First arg must be a 32-byte Uint8Array
    const firstCall = wrapItemKeyMock.mock.calls[0];
    const rawKey = firstCall[0] as Uint8Array;
    expect(rawKey).toBeInstanceOf(Uint8Array);
    expect(rawKey.length).toBe(32);
    // Third arg (AAD) is a non-empty string
    expect(typeof firstCall[2]).toBe("string");
  });

  it("toasts version-conflict when 409 returned", async () => {
    setupRotateFetch({ rotateOk: false, rotateStatus: 409 });
    render(<TeamRotateKeyButton teamId="team-1" />);
    await openAndConfirm();
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("rotateKeyVersionConflict");
    });
  });

  it("disables confirm button until 'rotate' typed", async () => {
    setupRotateFetch();
    render(<TeamRotateKeyButton teamId="team-1" />);
    fireEvent.click(screen.getByText("rotateKeyButton"));
    const confirmBtn = await screen.findByText("rotateKeyConfirm");
    expect(confirmBtn.closest("button")).toBeDisabled();
    // Type partial text — still disabled
    const input = screen.getByPlaceholderText("rotateKeyTypePlaceholder");
    fireEvent.change(input, { target: { value: "rota" } });
    expect(confirmBtn.closest("button")).toBeDisabled();
    // Now type full word
    fireEvent.change(input, { target: { value: "rotate" } });
    expect(confirmBtn.closest("button")).not.toBeDisabled();
  });
});
