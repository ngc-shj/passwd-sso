// @vitest-environment jsdom
// Real Web Crypto (Node's, see team-vault-core.crypto.test.tsx for why the
// jsdom wrapper is replaced): the button drives the real rotation builder.
import { createHash, webcrypto as nodeWebcrypto } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.stubGlobal("crypto", nodeWebcrypto);
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ResolveTeamKey } from "@/lib/team/team-key-resolution";

const {
  mockFetch,
  mockToast,
  newTeamKeysSnapshot,
  vault,
  mockCanUsePasskeyRecovery,
  mockReauthenticateWithPasskey,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  newTeamKeysSnapshot: { refs: [] as Uint8Array[], copies: [] as Uint8Array[] },
  vault: {
    resolve: null as ResolveTeamKey | null,
    invalidateTeamKey: vi.fn(),
    lockEpoch: 0,
  },
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    getLockEpoch: () => vault.lockEpoch,
    lockedSince: (epoch: number) => epoch !== vault.lockEpoch,
  }),
}));

vi.mock("@/lib/team/team-vault-core", () => ({
  useTeamVault: () => ({
    resolveTeamKey: (_teamId: string, version: number) => (vault.resolve as ResolveTeamKey)(version),
    invalidateTeamKey: vault.invalidateTeamKey,
  }),
}));

// Pass-through: records the new team key buffer so its zeroization is observable.
vi.mock("@/lib/crypto/crypto-team", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/crypto/crypto-team")>();
  return {
    ...real,
    generateTeamSymmetricKey: () => {
      const raw = real.generateTeamSymmetricKey();
      newTeamKeysSnapshot.refs.push(raw);
      newTeamKeysSnapshot.copies.push(raw.slice());
      return raw;
    },
  };
});

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { generateECDHKeyPair, exportPublicKey, hexEncode } from "@/lib/crypto/crypto-team";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKey,
  makeTeamKeys,
  sealEntryV0,
  sealEntryV1,
} from "@/__tests__/helpers/team-key-fixtures";
import { TeamRotateKeyButton } from "./team-rotate-key-button";

async function v1(entryId: string, teamKey: CryptoKey, teamKeyVersion: number) {
  return sealEntryV1({
    entryId, teamKey, teamKeyVersion, itemKey: generateItemKey(), itemKeyVersion: 1,
    itemKeyId: crypto.randomUUID(), blob: "{}", overview: "{}",
  });
}

const memberPublicKeys: string[] = [];

async function setupRotateFetch(opts: {
  entries: Record<string, unknown>[];
  actorKeyVersions: number[];
  rotateStatus?: number;
  rotateBody?: Record<string, unknown>;
  /** Replaces the rotate POST's response (a reject, a non-JSON page). */
  rotateResponse?: () => Promise<Response>;
  versionHolders?: Record<string, unknown>;
}) {
  const member = await generateECDHKeyPair();
  const members = [{ userId: "u1", ecdhPublicKey: await exportPublicKey(member.publicKey) }];
  memberPublicKeys.push(members[0].ecdhPublicKey);
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("rotate-key/data")) {
      return Promise.resolve(new Response(JSON.stringify({
        teamKeyVersion: 2,
        entries: opts.entries,
        members,
        actorKeyVersions: opts.actorKeyVersions,
      }), { status: 200 }));
    }
    if (url.includes("/rekey?limit=1")) {
      return Promise.resolve(new Response(JSON.stringify({
        pendingCount: opts.entries.length,
        stateCounts: { ready: opts.entries.length, needs_rekeyer_holder: 0, holder_cannot_rekey: 0, unrecoverable: 0 },
        holders: {},
        versionHolders: opts.versionHolders ?? {},
        retainedHistoryCount: 0,
        entryIds: [],
      }), { status: 200 }));
    }
    if (init?.method === "POST") {
      if (opts.rotateResponse) return opts.rotateResponse();
      return Promise.resolve(new Response(JSON.stringify(opts.rotateBody ?? { success: true }), {
        status: opts.rotateStatus ?? 200,
      }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function postedBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
  if (!call) throw new Error("no POST");
  return JSON.parse((call[1] as RequestInit).body as string);
}

async function openAndConfirm() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));
  });
  fireEvent.change(await screen.findByPlaceholderText("rotateKeyTypePlaceholder"), { target: { value: "rotate" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyConfirm" }));
  });
}

describe("TeamRotateKeyButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newTeamKeysSnapshot.refs.length = 0;
    newTeamKeysSnapshot.copies.length = 0;
    memberPublicKeys.length = 0;
    vault.lockEpoch = 0;
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("renders the rotate-key trigger button", () => {
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);
    expect(screen.getByRole("button", { name: "rotateKeyButton" })).toBeInTheDocument();
  });

  it("holds the trigger while a re-key pass runs (disabled), and enables it otherwise", () => {
    const { rerender } = render(<TeamRotateKeyButton teamId={TEAM_ID} disabled />);
    expect(screen.getByRole("button", { name: "rotateKeyButton" })).toBeDisabled();
    rerender(<TeamRotateKeyButton teamId={TEAM_ID} />);
    expect(screen.getByRole("button", { name: "rotateKeyButton" })).toBeEnabled();
  });

  it("disables confirm until 'rotate' is typed", async () => {
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));
    const confirm = await screen.findByRole("button", { name: "rotateKeyConfirm" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("rotateKeyTypePlaceholder"), { target: { value: "rota" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("rotateKeyTypePlaceholder"), { target: { value: "rotate" } });
    expect(confirm).not.toBeDisabled();
  });

  it("sends each entry opened at its own version, carries the version it does not hold, and snapshots v0's two IVs", async () => {
    const keys = await makeTeamKeys([1, 2]);
    vault.resolve = makeResolver(keys);
    const current = await v1("e-current", keys.get(2)!, 2);
    const stale = await v1("e-stale", keys.get(1)!, 1);
    const legacy = await sealEntryV0({ entryId: "e-v0", teamKey: keys.get(2)!, teamKeyVersion: 2, blob: "b", overview: "o" });
    const notHeld = await v1("e-not-held", await makeTeamKey(), 3);
    await setupRotateFetch({ entries: [current, stale, legacy, notHeld], actorKeyVersions: [1, 2] });
    const onSuccess = vi.fn();
    render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

    await openAndConfirm();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    const body = postedBody() as {
      newTeamKeyVersion: number;
      entries: { id: string; snapshotIv: string; snapshotOverviewIv?: string }[];
      carry: unknown[];
    };
    expect(body.newTeamKeyVersion).toBe(3);
    expect(body.entries.map((e) => [e.id, e.snapshotIv, e.snapshotOverviewIv])).toEqual([
      ["e-current", current.itemKeyIv, undefined],
      ["e-stale", stale.itemKeyIv, undefined],
      ["e-v0", legacy.blobIv, legacy.overviewIv],
    ]);
    expect(body.carry).toEqual([{ id: "e-not-held", teamKeyVersion: 3, reason: "not_held" }]);
    expect((postedBody() as { memberKeys: { recipientKeyFingerprint: string }[] }).memberKeys).toEqual([
      expect.objectContaining({
        recipientKeyFingerprint: createHash("sha256").update(memberPublicKeys[0], "utf8").digest("hex"),
      }),
    ]);
    expect(vault.invalidateTeamKey).toHaveBeenCalledWith(TEAM_ID);
  });

  it("aborts with no POST when a key fails transiently", async () => {
    const keys = await makeTeamKeys([1, 2]);
    vault.resolve = makeResolver(keys, { 1: "transient" });
    await setupRotateFetch({ entries: [await v1("e", keys.get(1)!, 1)], actorKeyVersions: [1, 2] });
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("rotateKeyAborted"));
    expect(mockFetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  // The vault's keys were dropped (a lock, a session end or user switch) while
  // the rotation was being built: the new key is never sent.
  it("sends no rotation once the vault lock epoch moved since the start", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = async (version) => {
      vault.lockEpoch += 1;
      return makeResolver(keys)(version);
    };
    await setupRotateFetch({ entries: [await v1("e", keys.get(2)!, 2)], actorKeyVersions: [2] });
    const onSuccess = vi.fn();
    render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("rotateKeyVaultRequired"));
    expect(mockFetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  // The proxy refused the POST before the route ran: a definite "nothing
  // rotated", never the outcome-unknown path that reloads as if it committed.
  it("reports a session change on the POST as not rotated, not as outcome unknown", async () => {
    const { SessionChangedError } = await import("@/lib/url-helpers");
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("e", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      rotateResponse: () => Promise.reject(new SessionChangedError()),
    });
    const onSuccess = vi.fn();
    render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("sessionChanged"));
    expect(mockToast.error).not.toHaveBeenCalledWith("rotateKeyOutcomeUnknown");
    expect(vault.invalidateTeamKey).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("zeroes the new team key and never sends it", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({ entries: [await v1("e", keys.get(2)!, 2)], actorKeyVersions: [2] });
    // Only the key the button generates (the fixtures generate their own).
    newTeamKeysSnapshot.refs.length = 0;
    newTeamKeysSnapshot.copies.length = 0;
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());

    expect(newTeamKeysSnapshot.refs).toHaveLength(1);
    expect(newTeamKeysSnapshot.refs[0].every((b) => b === 0)).toBe(true);
    expect(JSON.stringify(postedBody()).toLowerCase()).not.toContain(hexEncode(newTeamKeysSnapshot.copies[0]));
  });

  it.each([
    [409, "TEAM_KEY_VERSION_MISMATCH", "rotateKeyVersionConflict"],
    [409, "ENTRY_COUNT_MISMATCH", "rotateKeyEntryMismatch"],
    [409, "TEAM_ROTATE_CARRY_INVALID", "teamRotateCarryInvalid"],
    [409, "TEAM_ROTATE_KEY_UNAVAILABLE", "teamRotateKeyUnavailable"],
    [403, "ACTOR_NOT_PERMITTED", "actorNotPermitted"],
    [400, "VALIDATION_ERROR", "rotateKeyMembersChanged"],
    [429, "RATE_LIMIT_EXCEEDED", "rotateKeyRateLimited"],
  ])("maps a %i %s refusal to its own message", async (status, code, message) => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("e", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      rotateStatus: status,
      rotateBody: { error: code },
    });
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(message));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("keeps the refusal toast and the cached team key on an allow-listed refusal", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("e", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      rotateStatus: 409,
      rotateBody: { error: "TEAM_KEY_RECIPIENT_CHANGED" },
    });
    const onSuccess = vi.fn();
    render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("teamKeyRecipientChanged"));
    expect(mockToast.error).not.toHaveBeenCalledWith("rotateKeyOutcomeUnknown");
    expect(vault.invalidateTeamKey).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  describe("when the POST's outcome is unknown", () => {
    it.each([
      ["the POST rejects in transit", () => Promise.reject(new TypeError("Failed to fetch"))],
      [
        "a proxy answers 502 with an HTML page",
        () => Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })),
      ],
      [
        "a 500 carries INTERNAL_ERROR, which does not prove nothing committed",
        () => Promise.resolve(new Response(JSON.stringify({ error: "INTERNAL_ERROR" }), { status: 500 })),
      ],
    ])("%s: drops the cached team key, refreshes the page and says it is unknown", async (_label, rotateResponse) => {
      const keys = await makeTeamKeys([2]);
      vault.resolve = makeResolver(keys);
      await setupRotateFetch({ entries: [await v1("e", keys.get(2)!, 2)], actorKeyVersions: [2], rotateResponse });
      const onSuccess = vi.fn();
      render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

      await openAndConfirm();

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("rotateKeyOutcomeUnknown"));
      expect(mockToast.error).not.toHaveBeenCalledWith("rotateKeyFailed");
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(vault.invalidateTeamKey).toHaveBeenCalledWith(TEAM_ID);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("treats a 2xx whose body is unreadable as a committed rotation", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("e", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      rotateResponse: () => Promise.resolve(new Response("not json", { status: 200 })),
    });
    const onSuccess = vi.fn();
    render(<TeamRotateKeyButton teamId={TEAM_ID} onSuccess={onSuccess} />);

    await openAndConfirm();

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("rotateKeySuccess"));
    expect(vault.invalidateTeamKey).toHaveBeenCalledWith(TEAM_ID);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED rotate (RT8)", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("e", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      rotateStatus: 403,
      rotateBody: { error: "SESSION_STEP_UP_REQUIRED" },
    });
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("after a rotation that carried undecryptable entries, shows the report with its exits and the key suspicion, never delete", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    // Two of three entries at v2 fail authentication under the held key.
    const planted1 = await v1("p1", await makeTeamKey(), 2);
    const planted2 = await v1("p2", await makeTeamKey(), 2);
    const authentic = await v1("a1", keys.get(2)!, 2);
    await setupRotateFetch({
      entries: [planted1, planted2, authentic],
      actorKeyVersions: [2],
      versionHolders: {
        2: { callerHolds: true, activeHolderCount: 2, holders: [{ id: "y", name: "Yamada", email: null, canRekey: true }], deactivatedHolderCount: 0 },
      },
    });
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();

    const report = await screen.findByRole("region", { name: "rekeyReportTitle" });
    expect(report).toHaveTextContent('rekeyIssueUndecryptable:{"count":2}');
    expect(report).toHaveTextContent('rekeyKeySuspicion:{"version":2}');
    // Holder Y is named as the exit.
    expect(report).toHaveTextContent("rekeyExitAnotherHolderNamed");
    expect(report).toHaveTextContent("Yamada");
    expect(report).not.toHaveTextContent("rekeyExitDelete");
    expect((postedBody().carry as unknown[]).length).toBe(2);
  });

  it("gives the sole active holder restore and compare-keys exits, never delete", async () => {
    const keys = await makeTeamKeys([2]);
    vault.resolve = makeResolver(keys);
    await setupRotateFetch({
      entries: [await v1("p1", await makeTeamKey(), 2), await v1("a1", keys.get(2)!, 2)],
      actorKeyVersions: [2],
      versionHolders: { 2: { callerHolds: true, activeHolderCount: 1, holders: [], deactivatedHolderCount: 0 } },
    });
    render(<TeamRotateKeyButton teamId={TEAM_ID} />);

    await openAndConfirm();

    const report = await screen.findByRole("region", { name: "rekeyReportTitle" });
    expect(report).toHaveTextContent("rekeyExitRestoreCurrentVersion");
    expect(report).toHaveTextContent("rekeyExitCompareKeys");
    expect(report).not.toHaveTextContent("rekeyExitAnotherHolder");
    expect(report).not.toHaveTextContent("rekeyExitDelete");
  });
});
