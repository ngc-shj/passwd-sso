import { describe, expect, it, vi } from "vitest";
import { encryptBinary } from "@/lib/crypto/crypto-client";
import { deriveItemEncryptionKey } from "@/lib/crypto/crypto-team";
import { buildAttachmentAAD } from "@/lib/crypto/crypto-aad";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKeys,
  sealAttachmentCek,
  sealEntryV0,
  sealEntryV1,
} from "@/__tests__/helpers/team-key-fixtures";
import { bytesToBase64, type TeamAttachmentDownload } from "@/lib/team/team-attachment-crypto";
import type { RekeyEntryData } from "@/lib/team/rekey-payload";
import type { TeamKeyFailureReason } from "@/lib/team/team-key-resolution";
import {
  REKEY_BUSY_MAX_WAIT_MS,
  REKEY_ROTATION_PAUSE_MS,
  REKEY_STOP_REASON,
  runRekeyPass,
} from "./rekey-runner";

// ─── A fake server over real-crypto rows ────────────────────────────────────

const CURRENT = 3;

type Scripted = { status: number; code?: string; headers?: Record<string, string>; effect?: () => void };

interface FakeEntry {
  data: RekeyEntryData;
  itemKey: Uint8Array | null;
  pending: boolean;
  downloads: Map<string, TeamAttachmentDownload>;
}

class FakeServer {
  entries = new Map<string, FakeEntry>();
  /** Scripted responses per "METHOD path-kind:entryId", consumed in order before the default. */
  script = new Map<string, Scripted[]>();
  calls: string[] = [];

  queue(key: string, ...responses: Scripted[]) {
    this.script.set(key, [...(this.script.get(key) ?? []), ...responses]);
  }

  private scripted(key: string): Response | null {
    const next = this.script.get(key)?.shift();
    if (!next) return null;
    next.effect?.();
    return new Response(next.code ? JSON.stringify({ error: next.code }) : "{}", {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  }

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const url = new URL(path, "http://test");
    const parts = url.pathname.split("/").filter(Boolean); // api teams T ...
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (parts[3] === "rekey") {
      this.calls.push("LIST");
      const scripted = this.scripted("GET list");
      if (scripted) return scripted;
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const pending = [...this.entries.entries()].filter(([, e]) => e.pending).map(([id]) => id).sort();
      return json({
        pendingCount: pending.length,
        stateCounts: { ready: pending.length, needs_rekeyer_holder: 0, holder_cannot_rekey: 0, unrecoverable: 0 },
        holders: {},
        retainedHistoryCount: 0,
        entryIds: pending.filter((id) => !after || id > after).slice(0, limit),
      });
    }

    const entryId = parts[4];
    const fake = this.entries.get(entryId);
    const kind = parts.length === 5 ? "entry" : parts[5] === "rekey" ? "rekey" : parts.length === 8 ? "migrate" : "attachment";
    const key = `${method} ${kind}:${entryId}`;
    this.calls.push(key);
    const scripted = this.scripted(key);
    if (scripted) return scripted;
    if (!fake) return new Response(JSON.stringify({ error: API_ERROR.NOT_FOUND }), { status: 404 });

    if (kind === "rekey" && method === "GET") {
      return json({
        ...fake.data,
        entry: { ...fake.data.entry, itemKeyTeamKeyVersion: fake.pending ? 1 : CURRENT },
      });
    }
    if (kind === "rekey" && method === "POST") {
      fake.pending = false;
      return json({ success: true, itemKeyVersion: fake.data.nextItemKeyVersion });
    }
    if (kind === "entry" && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      fake.data.entry = {
        ...fake.data.entry,
        encryptedBlob: body.encryptedBlob.ciphertext,
        blobIv: body.encryptedBlob.iv,
        blobAuthTag: body.encryptedBlob.authTag,
        encryptedOverview: body.encryptedOverview.ciphertext,
        overviewIv: body.encryptedOverview.iv,
        overviewAuthTag: body.encryptedOverview.authTag,
        teamKeyVersion: body.teamKeyVersion,
        itemKeyVersion: body.itemKeyVersion,
        encryptedItemKey: body.encryptedItemKey.ciphertext,
        itemKeyIv: body.encryptedItemKey.iv,
        itemKeyAuthTag: body.encryptedItemKey.authTag,
        itemKeyId: crypto.randomUUID(),
      };
      fake.data.nextItemKeyVersion = body.itemKeyVersion + 1;
      return json({ id: entryId });
    }
    const attachmentId = parts[6];
    if (kind === "attachment" && method === "GET") {
      const dl = fake.downloads.get(attachmentId);
      return dl ? json(dl) : new Response(JSON.stringify({ error: API_ERROR.ATTACHMENT_NOT_FOUND }), { status: 404 });
    }
    if (kind === "migrate" && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      this.markMigrated(fake, attachmentId, body);
      return json({ success: true });
    }
    return new Response("{}", { status: 500 });
  };

  markMigrated(fake: FakeEntry, attachmentId: string, body: Record<string, unknown>) {
    fake.data.attachments = fake.data.attachments.map((a) =>
      a.id === attachmentId
        ? {
            ...a,
            encryptionMode: 2,
            cekEncrypted: body.cekEncrypted as string,
            cekIv: body.cekIv as string,
            cekAuthTag: body.cekAuthTag as string,
            cekKeyVersion: body.cekKeyVersion as number,
            cekWrapAadVersion: 1,
            cekItemKeyId: fake.data.entry.itemKeyId ?? null,
          }
        : a,
    );
    fake.downloads.delete(attachmentId);
  }

  posts(entryId: string) {
    return this.calls.filter((c) => c === `POST rekey:${entryId}`).length;
  }
}

async function setup(opts: { ids?: string[]; v0?: string[]; failures?: Record<number, TeamKeyFailureReason> } = {}) {
  const keys = await makeTeamKeys([1, 2, CURRENT]);
  const server = new FakeServer();
  for (const id of opts.ids ?? ["e1"]) {
    const isV0 = opts.v0?.includes(id);
    const itemKey = isV0 ? null : generateItemKey();
    const entry = isV0
      ? await sealEntryV0({ entryId: id, teamKey: keys.get(2)!, teamKeyVersion: 2, blob: "b", overview: "o" })
      : await sealEntryV1({
          entryId: id,
          teamKey: keys.get(2)!,
          teamKeyVersion: 2,
          itemKey: itemKey as Uint8Array,
          itemKeyVersion: 1,
          itemKeyId: crypto.randomUUID(),
          blob: "b",
          overview: "o",
        });
    server.entries.set(id, {
      data: { entry, history: [], attachments: [], nextItemKeyVersion: 2, teamKeyVersion: CURRENT },
      itemKey,
      pending: true,
      downloads: new Map(),
    });
  }
  const deps = {
    teamId: TEAM_ID,
    fetch: server.fetch,
    resolveKey: makeResolver(keys, opts.failures),
    invalidateTeamKeys: vi.fn(),
    reauthenticate: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
  };
  return { server, deps, keys };
}

/** Give entry `id` a legacy mode-1 attachment encrypted under its live ItemKey. */
async function addLegacyAttachment(server: FakeServer, id: string, attachmentId = "a1") {
  (await prepareLegacyAttachment(server, id, attachmentId))();
}

/** The same, installed later by the returned function (for a scripted effect). */
async function prepareLegacyAttachment(server: FakeServer, id: string, attachmentId = "a1"): Promise<() => void> {
  const fake = server.entries.get(id)!;
  const content = await deriveItemEncryptionKey(fake.itemKey as Uint8Array);
  const body = await encryptBinary(new TextEncoder().encode("file").buffer as ArrayBuffer, content, buildAttachmentAAD(id, attachmentId));
  const e = fake.data.entry;
  return () => {
  fake.data.attachments.push({
    id: attachmentId,
    encryptionMode: 1,
    iv: body.iv,
    authTag: body.authTag,
    keyVersion: 2,
    cekEncrypted: null,
    cekIv: null,
    cekAuthTag: null,
    cekKeyVersion: null,
    cekWrapAadVersion: null,
    cekItemKeyId: null,
  });
  fake.downloads.set(attachmentId, {
    id: attachmentId,
    filename: "f.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    encryptedData: bytesToBase64(body.ciphertext),
    iv: body.iv,
    authTag: body.authTag,
    aadVersion: 1,
    encryptionMode: 1,
    keyVersion: 2,
    itemKeyWraps: [{
      encryptedItemKey: e.encryptedItemKey as string,
      itemKeyIv: e.itemKeyIv as string,
      itemKeyAuthTag: e.itemKeyAuthTag as string,
      teamKeyVersion: e.teamKeyVersion,
      itemKeyVersion: e.itemKeyVersion,
    }],
  });
  };
}

// ─── Status table: one cell per row ─────────────────────────────────────────

describe("runRekeyPass status table", () => {
  it("re-keys every pending entry with one POST each (baseline)", async () => {
    const { server, deps } = await setup({ ids: ["e1", "e2"] });

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1", "e2"]);
    expect(server.posts("e1")).toBe(1);
  });

  it.each([API_ERROR.TEAM_KEY_VERSION_CHANGED, API_ERROR.TEAM_KEY_VERSION_MISMATCH])(
    "%s → invalidates the team key cache, pauses, re-fetches and continues",
    async (code) => {
      const { server, deps } = await setup();
      server.queue("POST rekey:e1", { status: 409, code });

      const result = await runRekeyPass(deps);

      expect(deps.invalidateTeamKeys).toHaveBeenCalledTimes(1);
      expect(deps.sleep).toHaveBeenCalledWith(REKEY_ROTATION_PAUSE_MS);
      expect(result.rekeyed).toEqual(["e1"]);
      expect(server.posts("e1")).toBe(2);
    },
  );

  it("TEAM_KEY_VERSION_MISMATCH on the upgrade PUT → invalidates, re-fetches, continues", async () => {
    const { server, deps } = await setup({ v0: ["e1"] });
    server.queue("PUT entry:e1", { status: 409, code: API_ERROR.TEAM_KEY_VERSION_MISMATCH });

    const result = await runRekeyPass(deps);

    expect(deps.invalidateTeamKeys).toHaveBeenCalled();
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("restarts from the first page after a rotation commits mid-pass", async () => {
    const { server, deps } = await setup({ ids: ["e1", "e2"] });
    // e1 re-keyed, then a rotation re-opens it while e2 is posted.
    server.queue("POST rekey:e2", {
      status: 409,
      code: API_ERROR.TEAM_KEY_VERSION_CHANGED,
      effect: () => {
        server.entries.get("e1")!.pending = true;
      },
    });

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(server.posts("e1")).toBe(2);
    expect([...server.entries.values()].every((e) => !e.pending)).toBe(true);
  });

  it.each([
    API_ERROR.REKEY_SNAPSHOT_MISMATCH,
    API_ERROR.REKEY_SET_MISMATCH,
    API_ERROR.ITEM_KEY_CHANGED,
    API_ERROR.ITEM_KEY_VERSION_INVALID,
  ])("%s → re-GETs and retries once", async (code) => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", { status: 409, code });

    const result = await runRekeyPass(deps);

    expect(result.rekeyed).toEqual(["e1"]);
    expect(server.calls.filter((c) => c === "GET rekey:e1")).toHaveLength(2);
  });

  it("REKEY_SNAPSHOT_MISMATCH twice → skipped and reported after the one retry", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1",
      { status: 409, code: API_ERROR.REKEY_SNAPSHOT_MISMATCH },
      { status: 409, code: API_ERROR.REKEY_SNAPSHOT_MISMATCH });

    const result = await runRekeyPass(deps);

    expect(server.posts("e1")).toBe(2);
    expect(result.skipped).toEqual([{ entryId: "e1", reason: API_ERROR.REKEY_SNAPSHOT_MISMATCH }]);
  });

  it("MIGRATE_CAS_FAILED → re-GETs and retries the migrate once", async () => {
    const { server, deps } = await setup();
    await addLegacyAttachment(server, "e1");
    server.queue("PUT migrate:e1", { status: 409, code: API_ERROR.MIGRATE_CAS_FAILED });

    const result = await runRekeyPass(deps);

    expect(server.calls.filter((c) => c === "PUT migrate:e1")).toHaveLength(2);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("ENTRY_REKEY_REQUIRED → re-keys instead of editing", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", { status: 409, code: API_ERROR.ENTRY_REKEY_REQUIRED });

    const result = await runRekeyPass(deps);

    expect(result.rekeyed).toEqual(["e1"]);
    expect(server.calls.filter((c) => c.startsWith("PUT entry"))).toEqual([]);
  });

  it.each([API_ERROR.ENTRY_UPGRADE_REQUIRED, API_ERROR.CEK_KEY_VERSION_MISMATCH])(
    "%s → re-GETs, upgrades again if v0, retries once",
    async (code) => {
      const { server, deps, keys } = await setup();
      const v0 = await sealEntryV0({ entryId: "e1", teamKey: keys.get(2)!, teamKeyVersion: 2, blob: "b", overview: "o" });
      // A restore turned the entry back to v0 under the request.
      server.queue("POST rekey:e1", { status: 409, code, effect: () => { server.entries.get("e1")!.data.entry = v0; } });

      const result = await runRekeyPass(deps);

      expect(server.calls.filter((c) => c === "PUT entry:e1")).toHaveLength(1);
      expect(result.rekeyed).toEqual(["e1"]);
    },
  );

  it("upgrades a v0 entry by PUT before the re-key POST", async () => {
    const { server, deps } = await setup({ v0: ["e1"] });

    const result = await runRekeyPass(deps);

    const order = server.calls.filter((c) => c === "PUT entry:e1" || c === "POST rekey:e1");
    expect(order).toEqual(["PUT entry:e1", "POST rekey:e1"]);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("resolver key_invalid → skips and reports the live entry, sends no POST for it, continues", async () => {
    const { server, deps, keys } = await setup({ ids: ["e1", "e2"] });
    // e2 lives at version 1, whose key row is broken.
    const fake = server.entries.get("e2")!;
    fake.data.entry = await sealEntryV1({
      entryId: "e2", teamKey: keys.get(1)!, teamKeyVersion: 1, itemKey: generateItemKey(), itemKeyVersion: 1,
      itemKeyId: crypto.randomUUID(), blob: "b", overview: "o",
    });
    deps.resolveKey = makeResolver(keys, { 1: "key_invalid" });

    const result = await runRekeyPass(deps);

    expect(result.keyInvalid).toEqual([{ entryId: "e2", teamKeyVersion: 1 }]);
    expect(server.posts("e2")).toBe(0);
    expect(result.rekeyed).toEqual(["e1"]);
    expect(result.status).toBe("completed");
  });

  it("REKEY_ATTACHMENTS_UNMIGRATED → migrates, then retries", async () => {
    const { server, deps } = await setup();
    const install = await prepareLegacyAttachment(server, "e1");
    server.queue("POST rekey:e1", { status: 409, code: API_ERROR.REKEY_ATTACHMENTS_UNMIGRATED, effect: install });

    const result = await runRekeyPass(deps);

    expect(server.calls).toContain("PUT migrate:e1");
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("MIGRATE_NOT_LEGACY → that attachment is done", async () => {
    const { server, deps } = await setup();
    await addLegacyAttachment(server, "e1");
    const fake = server.entries.get("e1")!;
    // Another admin migrated it first.
    const mode2 = await sealAttachmentCek({
      id: "a1", entryId: "e1", itemKey: fake.itemKey as Uint8Array, itemKeyVersion: 1,
      itemKeyId: fake.data.entry.itemKeyId ?? null, cek: crypto.getRandomValues(new Uint8Array(32)),
    });
    server.queue("PUT migrate:e1", {
      status: 409,
      code: API_ERROR.MIGRATE_NOT_LEGACY,
      effect: () => {
        fake.data.attachments = [mode2];
        fake.downloads.clear();
      },
    });

    const result = await runRekeyPass(deps);

    expect(server.calls.filter((c) => c === "PUT migrate:e1")).toHaveLength(1);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("ITEM_KEY_IV_REUSED → skips and reports, the pass continues", async () => {
    const { server, deps } = await setup({ ids: ["e1", "e2"] });
    server.queue("POST rekey:e1", { status: 400, code: API_ERROR.ITEM_KEY_IV_REUSED });

    const result = await runRekeyPass(deps);

    expect(result.skipped).toEqual([{ entryId: "e1", reason: API_ERROR.ITEM_KEY_IV_REUSED }]);
    expect(result.rekeyed).toEqual(["e2"]);
    expect(result.status).toBe("completed");
  });

  it.each([
    API_ERROR.MIGRATE_HASH_MISMATCH,
    API_ERROR.MIGRATE_LENGTH_CHANGED,
    API_ERROR.MIGRATE_METADATA_CHANGED,
    API_ERROR.BLOB_REF_INVALID,
  ])("%s → skips and reports the entry, sends no re-key POST", async (code) => {
    const { server, deps } = await setup();
    await addLegacyAttachment(server, "e1");
    server.queue("PUT migrate:e1", { status: 409, code });

    const result = await runRekeyPass(deps);

    expect(result.skipped).toEqual([{ entryId: "e1", reason: code }]);
    expect(server.posts("e1")).toBe(0);
    expect(result.status).toBe("completed");
  });

  it.each([API_ERROR.ACTOR_NOT_PERMITTED, API_ERROR.REKEY_POSTCHECK_FAILED, API_ERROR.INTERNAL_ERROR])(
    "%s → stops the pass and reports",
    async (code) => {
      const { server, deps } = await setup({ ids: ["e1", "e2"] });
      server.queue("POST rekey:e1", { status: code === API_ERROR.ACTOR_NOT_PERMITTED ? 403 : 500, code });

      const result = await runRekeyPass(deps);

      expect(result.status).toBe("stopped");
      expect(result.stop).toEqual({ reason: REKEY_STOP_REASON.REFUSED, code, entryId: "e1" });
      expect(server.posts("e2")).toBe(0);
    },
  );

  it("409 REKEY_NOT_PENDING → that entry is done", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", {
      status: 409,
      code: API_ERROR.REKEY_NOT_PENDING,
      effect: () => { server.entries.get("e1")!.pending = false; },
    });

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual([]);
    expect(server.posts("e1")).toBe(1);
  });

  it("404 → that entry is done", async () => {
    const { server, deps } = await setup();
    server.queue("GET rekey:e1", {
      status: 404,
      code: API_ERROR.NOT_FOUND,
      effect: () => { server.entries.delete("e1"); },
    });

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(server.posts("e1")).toBe(0);
  });

  it("429 → waits for Retry-After, then retries", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", { status: 429, code: API_ERROR.RATE_LIMIT_EXCEEDED, headers: { "Retry-After": "7" } });

    const result = await runRekeyPass(deps);

    expect(deps.sleep).toHaveBeenCalledWith(7000);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("step-up required → re-authenticates and resumes", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", { status: 403, code: API_ERROR.SESSION_STEP_UP_REQUIRED });

    const result = await runRekeyPass(deps);

    expect(deps.reauthenticate).toHaveBeenCalledTimes(1);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("step-up required on the migrate PUT → re-authenticates and resumes", async () => {
    const { server, deps } = await setup();
    await addLegacyAttachment(server, "e1");
    server.queue("PUT migrate:e1", { status: 403, code: API_ERROR.SESSION_STEP_UP_REQUIRED });

    const result = await runRekeyPass(deps);

    expect(deps.reauthenticate).toHaveBeenCalledTimes(1);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("a declined re-authentication stops the pass", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", { status: 403, code: API_ERROR.SESSION_STEP_UP_REQUIRED });
    deps.reauthenticate.mockResolvedValue(false);

    const result = await runRekeyPass(deps);

    expect(result.stop?.reason).toBe(REKEY_STOP_REASON.STEP_UP_DECLINED);
  });

  it("transient key failure → stops and reports, no POST", async () => {
    const { server, deps } = await setup({ failures: { 2: "transient" } });

    const result = await runRekeyPass(deps);

    expect(result.stop).toEqual({ reason: REKEY_STOP_REASON.TRANSIENT, entryId: "e1" });
    expect(server.posts("e1")).toBe(0);
  });

  it("a network failure → stops and reports", async () => {
    const { deps } = await setup();
    deps.fetch = async () => { throw new TypeError("network"); };

    const result = await runRekeyPass(deps);

    expect(result.stop?.reason).toBe(REKEY_STOP_REASON.TRANSIENT);
  });
});

describe("runRekeyPass TEAM_BUSY (a team lock wait timed out)", () => {
  const busy = (retryAfter?: string): Scripted => ({
    status: 409,
    code: API_ERROR.TEAM_BUSY,
    ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
  });
  const queueBusy = (server: FakeServer, key: string, count: number, retryAfter = "3") => {
    for (let i = 0; i < count; i++) server.queue(key, busy(retryAfter));
  };

  it("re-key POST: sleeps Retry-After, retries the same request, never invalidates the key cache", async () => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", busy("4"));

    const result = await runRekeyPass(deps);

    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(4000);
    expect(deps.invalidateTeamKeys).not.toHaveBeenCalled();
    expect(server.posts("e1")).toBe(2);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("upgrade PUT: sleeps Retry-After, retries, never invalidates the key cache", async () => {
    const { server, deps } = await setup({ v0: ["e1"] });
    server.queue("PUT entry:e1", busy("4"));

    const result = await runRekeyPass(deps);

    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(4000);
    expect(deps.invalidateTeamKeys).not.toHaveBeenCalled();
    expect(server.calls.filter((c) => c === "PUT entry:e1")).toHaveLength(2);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("migrate PUT: sleeps Retry-After, retries, never invalidates the key cache", async () => {
    const { server, deps } = await setup();
    await addLegacyAttachment(server, "e1");
    server.queue("PUT migrate:e1", busy("4"));

    const result = await runRekeyPass(deps);

    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(4000);
    expect(deps.invalidateTeamKeys).not.toHaveBeenCalled();
    expect(server.calls.filter((c) => c === "PUT migrate:e1")).toHaveLength(2);
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it.each([
    ["30", 30_000],
    ["31", REKEY_BUSY_MAX_WAIT_MS],
    ["3600", REKEY_BUSY_MAX_WAIT_MS],
    [undefined, 5_000],
  ])("Retry-After %s sleeps %i ms", async (retryAfter, expectedMs) => {
    const { server, deps } = await setup();
    server.queue("POST rekey:e1", busy(retryAfter));

    await runRekeyPass(deps);

    expect(deps.sleep).toHaveBeenCalledWith(expectedMs);
  });

  it("the 10th busy wait still retries", async () => {
    const { server, deps } = await setup();
    queueBusy(server, "POST rekey:e1", 10);

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1"]);
    expect(deps.sleep).toHaveBeenCalledTimes(10);
  });

  it("the 11th busy wait stops the pass with RETRY_BUDGET_EXHAUSTED", async () => {
    const { server, deps } = await setup();
    queueBusy(server, "POST rekey:e1", 11);

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("stopped");
    expect(result.stop).toEqual({
      reason: REKEY_STOP_REASON.RETRY_BUDGET_EXHAUSTED,
      code: API_ERROR.TEAM_BUSY,
      entryId: "e1",
    });
    expect(deps.sleep).toHaveBeenCalledTimes(10);
    expect(deps.invalidateTeamKeys).not.toHaveBeenCalled();
  });

  it("10 busy waits leave the full rotation budget: 5 rotation waits after them still succeed", async () => {
    const { server, deps } = await setup();
    queueBusy(server, "POST rekey:e1", 10);
    for (let i = 0; i < 5; i++) {
      server.queue("POST rekey:e1", { status: 409, code: API_ERROR.TEAM_KEY_VERSION_MISMATCH });
    }

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1"]);
    expect(deps.invalidateTeamKeys).toHaveBeenCalledTimes(5);
  });

  it("10 busy waits leave the full rate-limit budget: 10 rate-limit waits after them still succeed", async () => {
    const { server, deps } = await setup();
    queueBusy(server, "POST rekey:e1", 10);
    // On the list request: a per-entry step cap (20) would end the entry first.
    for (let i = 0; i < 10; i++) {
      server.queue("GET list", { status: 429, code: API_ERROR.RATE_LIMIT_EXCEEDED });
    }

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("rate-limit waits do not consume the busy budget", async () => {
    const { server, deps } = await setup();
    // On the list request: a per-entry step cap (20) would end the entry first.
    for (let i = 0; i < 10; i++) {
      server.queue("GET list", { status: 429, code: API_ERROR.RATE_LIMIT_EXCEEDED });
    }
    queueBusy(server, "POST rekey:e1", 10);

    const result = await runRekeyPass(deps);

    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1"]);
  });

  it("TEAM_BUSY then a genuine mismatch → refreshes the keys (REFRESH_KEYS)", async () => {
    const { server, deps } = await setup();
    server.queue(
      "POST rekey:e1",
      busy("3"),
      { status: 409, code: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
    );

    const result = await runRekeyPass(deps);

    expect(deps.invalidateTeamKeys).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, REKEY_ROTATION_PAUSE_MS);
    expect(result.rekeyed).toEqual(["e1"]);
  });
});

describe("runRekeyPass: an entry holding a legacy attachment whose live wrap does not open (F3)", () => {
  /** e2 at version 1 with a legacy attachment; e1 (version 2) is openable. */
  async function setupLegacyOnVersion1(failures: Record<number, TeamKeyFailureReason> = {}, tamper = false) {
    const { server, deps, keys } = await setup({ ids: ["e1", "e2"] });
    const fake = server.entries.get("e2")!;
    const itemKey = generateItemKey();
    fake.itemKey = itemKey;
    fake.data.entry = await sealEntryV1({
      entryId: "e2", teamKey: keys.get(1)!, teamKeyVersion: 1, itemKey, itemKeyVersion: 1,
      itemKeyId: crypto.randomUUID(), blob: "b", overview: "o",
    });
    if (tamper) {
      // The wrap fails authentication under the held version-1 key.
      fake.data.entry = { ...fake.data.entry, itemKeyAuthTag: "0".repeat(32) };
    }
    await addLegacyAttachment(server, "e2");
    await addLegacyAttachment(server, "e1");
    deps.resolveKey = makeResolver(keys, failures);
    return { server, deps };
  }

  it.each([
    ["not held", { 1: "not_available" as const }, false, "notHeld"],
    ["key row broken", { 1: "key_invalid" as const }, false, "keyInvalid"],
    ["wrap undecryptable", {}, true, "undecryptable"],
  ] as const)("%s → its own report bucket, nothing downloaded or migrated for it", async (_label, failures, tamper, bucket) => {
    const { server, deps } = await setupLegacyOnVersion1(failures, tamper);

    const result = await runRekeyPass(deps);

    expect(result[bucket]).toEqual([{ entryId: "e2", teamKeyVersion: 1 }]);
    expect(result.skipped.filter((s) => s.entryId === "e2")).toEqual([]);
    expect(server.calls).not.toContain("GET attachment:e2");
    expect(server.calls).not.toContain("PUT migrate:e2");
    expect(server.posts("e2")).toBe(0);
    // Control: the openable entry still migrates and re-keys.
    expect(server.calls).toContain("PUT migrate:e1");
    expect(result.rekeyed).toEqual(["e1"]);
    expect(result.status).toBe("completed");
  });
});

describe("runRekeyPass cancellation (F4)", () => {
  it("an aborted signal sends nothing more: the pass stops CANCELLED before its next request", async () => {
    const { server, deps } = await setup({ ids: ["e1", "e2"] });
    const controller = new AbortController();
    const fetch = deps.fetch;
    deps.fetch = async (path: string, init?: RequestInit) => {
      const res = await fetch(path, init);
      // Abort as soon as the first re-key POST answered.
      if (init?.method === "POST") controller.abort();
      return res;
    };

    const result = await runRekeyPass({ ...deps, signal: controller.signal });

    expect(result.status).toBe("stopped");
    expect(result.stop?.reason).toBe(REKEY_STOP_REASON.CANCELLED);
    expect(result.rekeyed).toEqual(["e1"]);
    expect(server.calls.filter((c) => c.endsWith(":e2"))).toEqual([]);
  });

  it("aborted while parked on re-authentication → stops CANCELLED (not STEP_UP_DECLINED) and sends nothing more", async () => {
    const { server, deps } = await setup();
    const controller = new AbortController();
    server.queue("POST rekey:e1", { status: 403, code: API_ERROR.SESSION_STEP_UP_REQUIRED });
    deps.reauthenticate = vi.fn(async () => {
      controller.abort();
      return false;
    });
    const result = await runRekeyPass({ ...deps, signal: controller.signal });

    expect(result.stop?.reason).toBe(REKEY_STOP_REASON.CANCELLED);
    expect(server.posts("e1")).toBe(1);
    // Nothing after the refused POST: no re-GET, no list.
    expect(server.calls.at(-1)).toBe("POST rekey:e1");
  });

  it("control: a signal that is never aborted lets the pass complete", async () => {
    const { deps } = await setup({ ids: ["e1", "e2"] });
    const result = await runRekeyPass({ ...deps, signal: new AbortController().signal });
    expect(result.status).toBe("completed");
    expect(result.rekeyed).toEqual(["e1", "e2"]);
  });
});

describe("runRekeyPass paging", () => {
  it("a page full of skipped entries does not starve the next page", async () => {
    const { server, deps, keys } = await setup({ ids: ["a1", "a2", "b3"] });
    for (const id of ["a1", "a2"]) {
      server.entries.get(id)!.data.entry = await sealEntryV1({
        entryId: id, teamKey: keys.get(1)!, teamKeyVersion: 1, itemKey: generateItemKey(), itemKeyVersion: 1,
        itemKeyId: crypto.randomUUID(), blob: "b", overview: "o",
      });
    }
    deps.resolveKey = makeResolver(keys, { 1: "key_invalid" });

    const result = await runRekeyPass({ ...deps, pageLimit: 2 });

    expect(result.rekeyed).toEqual(["b3"]);
    expect(result.keyInvalid.map((e) => e.entryId)).toEqual(["a1", "a2"]);
    expect(result.status).toBe("completed");
  });

  it("counts attempted entries per team key version for the suspicion line", async () => {
    const { deps } = await setup({ ids: ["e1", "e2"] });

    const result = await runRekeyPass(deps);

    expect(result.attemptedByVersion.get(2)).toBe(2);
  });
});
