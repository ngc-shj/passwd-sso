import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { CURRENT_CEK_WRAP_AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants/vault/attachment-encryption-mode";
import { ATTACHMENT_MANIFEST_CAP } from "@/lib/validations/common";
import {
  applyVaultRotation,
  applyAttachmentMigration,
  AttachmentCekManifestMismatchError,
  AttachmentCekWrapAadVersionMismatchError,
  AttachmentMigrationCasError,
  LegacyAttachmentInconsistentVersionError,
  LegacyAttachmentsResidualError,
  LegacyBodyHashMismatchError,
  LegacyMigrationNotApplicableError,
  Mode2InvariantViolationError,
  RotationCasConflictError,
  RotationPostConditionError,
  type AttachmentCekRewrap,
  type AttachmentMigrationOptions,
  type RotationPayload,
} from "./rotate-key-server";

// ── In-memory transaction fake ──────────────────────────────────────────────
// State-based: reads filter the rows below and writes mutate them, so the
// post-write sweep sees what the rotation actually wrote.

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "tenant-1";
const OLD_VERSION = 3;
const NEW_VERSION = 4;
const SETUP_AT = new Date("2026-01-01T00:00:00Z");
const SALT = "salt-old";

interface AttachmentRow {
  id: string;
  userId: string;
  tenantId: string;
  passwordEntryId: string | null;
  teamPasswordEntryId: string | null;
  encryptionMode: number;
  encryptedData: Uint8Array<ArrayBuffer>;
  iv: string;
  authTag: string;
  keyVersion: number | null;
  cekEncrypted: Uint8Array<ArrayBuffer> | null;
  cekIv: string | null;
  cekAuthTag: string | null;
  cekKeyVersion: number | null;
  cekWrapAadVersion: number | null;
}

interface Write {
  model: string;
  op: string;
  where?: unknown;
  data?: unknown;
}

interface State {
  casRows: Array<{ key_version: number; vault_setup_at: Date | null; account_salt: string | null }>;
  entries: Array<{ id: string; userId: string }>;
  history: Array<{ id: string; entryUserId: string }>;
  attachments: AttachmentRow[];
  recoveryEncryptedSecretKey: string | null;
  prfCredentials: number;
  staleableGrants: number;
  vaultKeyCreateError?: unknown;
  /** Force an updateMany count, by model, regardless of matching rows. */
  forceCount?: Partial<Record<"passwordEntry" | "passwordEntryHistory" | "attachment", number>>;
}

type AttachmentWhere = {
  id?: string;
  passwordEntry?: { userId?: string; tenantId?: string };
  passwordEntryId?: string;
  teamPasswordEntryId?: null;
  encryptionMode?: number;
  iv?: string;
  authTag?: string;
  cekKeyVersion?: { not: number };
  OR?: Array<Partial<Record<keyof AttachmentRow, null>>>;
};

function attachmentMatches(row: AttachmentRow, where: AttachmentWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.passwordEntry?.userId !== undefined && row.userId !== where.passwordEntry.userId) return false;
  if (where.passwordEntry?.tenantId !== undefined && row.tenantId !== where.passwordEntry.tenantId) return false;
  if (where.passwordEntryId !== undefined && row.passwordEntryId !== where.passwordEntryId) return false;
  if (where.teamPasswordEntryId === null && row.teamPasswordEntryId !== null) return false;
  if (where.encryptionMode !== undefined && row.encryptionMode !== where.encryptionMode) return false;
  if (where.iv !== undefined && row.iv !== where.iv) return false;
  if (where.authTag !== undefined && row.authTag !== where.authTag) return false;
  if (where.cekKeyVersion !== undefined && row.cekKeyVersion === where.cekKeyVersion.not) return false;
  if (where.OR !== undefined && !where.OR.some((cond) => Object.keys(cond).some((k) => row[k as keyof AttachmentRow] === null))) {
    return false;
  }
  return true;
}

function makeTx(state: State) {
  const writes: Write[] = [];
  const queryValues: unknown[][] = [];

  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryValues.push(values);
      return values[0] === USER ? state.casRows : [];
    },
    attachment: {
      count: async ({ where }: { where: AttachmentWhere }) =>
        state.attachments.filter((r) => attachmentMatches(r, where)).length,
      findMany: async ({ where }: { where: AttachmentWhere }) =>
        state.attachments
          .filter((r) => attachmentMatches(r, where))
          .map((r) => ({ id: r.id, cekKeyVersion: r.cekKeyVersion })) satisfies Prisma.AttachmentGetPayload<{
          select: { id: true; cekKeyVersion: true };
        }>[],
      findFirst: async ({ where }: { where: AttachmentWhere }) => {
        const row = state.attachments.find((r) => attachmentMatches(r, where));
        if (!row) return null;
        return {
          id: row.id,
          encryptionMode: row.encryptionMode,
          encryptedData: row.encryptedData,
          iv: row.iv,
          authTag: row.authTag,
          keyVersion: row.keyVersion,
        } satisfies Prisma.AttachmentGetPayload<{
          select: { id: true; encryptionMode: true; encryptedData: true; iv: true; authTag: true; keyVersion: true };
        }>;
      },
      updateMany: async ({ where, data }: { where: AttachmentWhere; data: Partial<AttachmentRow> }) => {
        writes.push({ model: "attachment", op: "updateMany", where, data });
        const matched = state.attachments.filter((r) => attachmentMatches(r, where));
        const count = state.forceCount?.attachment ?? matched.length;
        if (count > 0) for (const r of matched) Object.assign(r, data);
        return { count } satisfies Prisma.BatchPayload;
      },
    },
    passwordEntry: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        state.entries
          .filter((e) => e.userId === where.userId)
          .map((e) => ({ id: e.id })) satisfies Prisma.PasswordEntryGetPayload<{ select: { id: true } }>[],
      updateMany: async ({ where, data }: { where: { id: string; userId: string }; data: unknown }) => {
        writes.push({ model: "passwordEntry", op: "updateMany", where, data });
        const matched = state.entries.filter((e) => e.id === where.id && e.userId === where.userId).length;
        return { count: state.forceCount?.passwordEntry ?? matched } satisfies Prisma.BatchPayload;
      },
    },
    passwordEntryHistory: {
      findMany: async ({ where }: { where: { entry: { userId: string } } }) =>
        state.history
          .filter((h) => h.entryUserId === where.entry.userId)
          .map((h) => ({ id: h.id })) satisfies Prisma.PasswordEntryHistoryGetPayload<{ select: { id: true } }>[],
      updateMany: async ({ where, data }: { where: { id: string; entry: { userId: string } }; data: unknown }) => {
        writes.push({ model: "passwordEntryHistory", op: "updateMany", where, data });
        const matched = state.history.filter((h) => h.id === where.id && h.entryUserId === where.entry.userId).length;
        return { count: state.forceCount?.passwordEntryHistory ?? matched } satisfies Prisma.BatchPayload;
      },
    },
    user: {
      findUnique: async () =>
        ({ recoveryEncryptedSecretKey: state.recoveryEncryptedSecretKey }) satisfies Prisma.UserGetPayload<{
          select: { recoveryEncryptedSecretKey: true };
        }>,
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        writes.push({ model: "user", op: "update", where, data });
        return {};
      },
    },
    vaultKey: {
      create: async ({ data }: { data: unknown }) => {
        writes.push({ model: "vaultKey", op: "create", data });
        if (state.vaultKeyCreateError !== undefined) throw state.vaultKeyCreateError;
        return {};
      },
    },
    webAuthnCredential: {
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        writes.push({ model: "webAuthnCredential", op: "updateMany", where, data });
        return { count: state.prfCredentials } satisfies Prisma.BatchPayload;
      },
    },
    emergencyAccessGrant: {
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        writes.push({ model: "emergencyAccessGrant", op: "updateMany", where, data });
        return { count: state.staleableGrants } satisfies Prisma.BatchPayload;
      },
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, writes, queryValues };
}

function mode2Row(id: string, overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id,
    userId: USER,
    tenantId: TENANT,
    passwordEntryId: "e1",
    teamPasswordEntryId: null,
    encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED,
    encryptedData: new Uint8Array([1]),
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
    keyVersion: OLD_VERSION,
    cekEncrypted: new Uint8Array([9]),
    cekIv: "c".repeat(24),
    cekAuthTag: "d".repeat(32),
    cekKeyVersion: OLD_VERSION,
    cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
    ...overrides,
  };
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    casRows: [{ key_version: OLD_VERSION, vault_setup_at: new Date(SETUP_AT), account_salt: SALT }],
    entries: [
      { id: "e1", userId: USER },
      { id: "e2", userId: USER },
      { id: "foreign", userId: OTHER_USER },
    ],
    history: [{ id: "h1", entryUserId: USER }],
    attachments: [mode2Row("a1")],
    recoveryEncryptedSecretKey: "recovery-blob",
    prfCredentials: 2,
    staleableGrants: 1,
    ...overrides,
  };
}

const blob = { ciphertext: "ct", iv: "iv", authTag: "tag" };

function rewrap(id: string, overrides: Partial<AttachmentCekRewrap> = {}): AttachmentCekRewrap {
  return {
    id,
    cekEncrypted: Buffer.from("new-cek").toString("base64"),
    cekIv: "e".repeat(24),
    cekAuthTag: "f".repeat(32),
    cekKeyVersion: NEW_VERSION,
    cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
    ...overrides,
  };
}

function payload(overrides: Partial<RotationPayload> = {}): RotationPayload {
  return {
    encryptedSecretKey: "esk",
    secretKeyIv: "skiv",
    secretKeyAuthTag: "sktag",
    accountSalt: "salt-new",
    newAuthHash: "auth",
    newVerifierHash: "ab".repeat(32),
    verificationArtifact: { ciphertext: "vct", iv: "viv", authTag: "vtag" },
    entries: [
      { id: "e1", encryptedBlob: blob, encryptedOverview: blob, aadVersion: 1 },
      { id: "e2", encryptedBlob: blob, encryptedOverview: blob, aadVersion: 1 },
    ],
    historyEntries: [{ id: "h1", encryptedBlob: blob, aadVersion: 1 }],
    encryptedEcdhPrivateKey: "ecdh",
    ecdhPrivateKeyIv: "ecdhiv",
    ecdhPrivateKeyAuthTag: "ecdhtag",
    attachmentCekRewraps: [rewrap("a1")],
    ...overrides,
  };
}

function rotate(state: State, p: RotationPayload = payload(), cas?: { setupAt?: Date | null; salt?: string }) {
  const fake = makeTx(state);
  const promise = applyVaultRotation(
    fake.tx,
    USER,
    TENANT,
    OLD_VERSION,
    NEW_VERSION,
    "server-hash",
    "server-salt",
    p,
    cas && "setupAt" in cas ? (cas.setupAt ?? null) : new Date(SETUP_AT),
    cas?.salt ?? SALT,
  );
  return { ...fake, promise };
}

describe("applyVaultRotation — success", () => {
  it("re-encrypts entries, history and CEKs under the new key version and reports the effects", async () => {
    const state = baseState();
    const { promise } = rotate(state);

    await expect(promise).resolves.toEqual({
      recoveryKeyInvalidated: true,
      emergencyGrantsCleared: 1,
      prfCredentialsCleared: 2,
      cekRewrapsAttempted: 1,
      cekRewrapsSucceeded: 1,
      cekRewrapsFailed: 0,
      legacyAttachmentsMigratedClientReported: 0,
      mode0Residual: 0,
      cekRewrappedAttachmentIds: ["a1"],
      cekRewrappedAttachmentIdsOverflow: false,
    });
    expect(state.attachments[0].cekKeyVersion).toBe(NEW_VERSION);
    expect(Buffer.from(state.attachments[0].cekEncrypted ?? []).toString()).toBe("new-cek");
  });

  it("binds the CAS row lock to the caller's user id", async () => {
    const { promise, queryValues } = rotate(baseState());
    await promise;
    expect(queryValues).toEqual([[USER]]);
  });

  it("scopes every updateMany by the owning user (and tenant for attachments)", async () => {
    const { promise, writes } = rotate(baseState());
    await promise;

    const updateManys = writes.filter((w) => w.op === "updateMany");
    expect(updateManys.map((w) => w.model)).toEqual([
      "passwordEntry",
      "passwordEntry",
      "passwordEntryHistory",
      "attachment",
      "webAuthnCredential",
      "emergencyAccessGrant",
    ]);
    expect(updateManys[0].where).toEqual({ id: "e1", userId: USER });
    expect(updateManys[1].where).toEqual({ id: "e2", userId: USER });
    expect(updateManys[2].where).toEqual({ id: "h1", entry: { userId: USER } });
    expect(updateManys[3].where).toEqual({
      id: "a1",
      passwordEntry: { userId: USER, tenantId: TENANT },
      encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED,
    });
    expect(updateManys[4].where).toEqual({ userId: USER, prfEncryptedSecretKey: { not: null } });
    expect(updateManys[5].where).toMatchObject({ ownerId: USER });
  });

  it("writes the new wrapping to the user row and clears the recovery wrapping", async () => {
    const { promise, writes } = rotate(baseState());
    await promise;

    const userUpdate = writes.find((w) => w.model === "user");
    expect(userUpdate?.where).toEqual({ id: USER });
    expect(userUpdate?.data).toMatchObject({
      encryptedSecretKey: "esk",
      accountSalt: "salt-new",
      masterPasswordServerHash: "server-hash",
      masterPasswordServerSalt: "server-salt",
      keyVersion: NEW_VERSION,
      recoveryEncryptedSecretKey: null,
      recoveryVerifierHmac: null,
      recoveryKeySetAt: null,
    });
  });

  it("stores an HMAC of the new verifier hash under the current pepper version", async () => {
    const verifier = "cd".repeat(32);
    const { promise, writes } = rotate(baseState(), payload({ newVerifierHash: verifier }));
    await promise;

    expect(writes.find((w) => w.model === "user")?.data).toMatchObject({
      passphraseVerifierHmac: hmacVerifier(verifier),
      passphraseVerifierVersion: VERIFIER_VERSION,
    });
  });

  it("creates the VaultKey row for the new version under the caller's user and tenant", async () => {
    const { promise, writes } = rotate(baseState());
    await promise;
    expect(writes.find((w) => w.model === "vaultKey")?.data).toEqual({
      userId: USER,
      tenantId: TENANT,
      version: NEW_VERSION,
      verificationCiphertext: "vct",
      verificationIv: "viv",
      verificationAuthTag: "vtag",
    });
  });

  it("reports recoveryKeyInvalidated=false when no recovery key was set", async () => {
    const { promise } = rotate(baseState({ recoveryEncryptedSecretKey: null }));
    await expect(promise).resolves.toMatchObject({ recoveryKeyInvalidated: false });
  });

  it("passes the client-reported legacy migration count through", async () => {
    const { promise } = rotate(baseState(), payload({ legacyAttachmentsMigratedThisCycle: 5 }));
    await expect(promise).resolves.toMatchObject({ legacyAttachmentsMigratedClientReported: 5 });
  });

  it("tolerates mode-2 rows that are not in the manifest only when they are already on the new version", async () => {
    const state = baseState({
      attachments: [mode2Row("a1"), mode2Row("concurrent", { cekKeyVersion: NEW_VERSION })],
    });
    await expect(rotate(state).promise).resolves.toMatchObject({ cekRewrappedAttachmentIds: ["a1"] });
  });

  it("caps the audited attachment id list and flags the overflow", async () => {
    const count = ATTACHMENT_MANIFEST_CAP + 1;
    const ids = Array.from({ length: count }, (_, i) => `att-${i}`);
    const state = baseState({ attachments: ids.map((id) => mode2Row(id)) });
    const result = await rotate(state, payload({ attachmentCekRewraps: ids.map((id) => rewrap(id)) })).promise;

    expect(result.cekRewrappedAttachmentIds).toHaveLength(ATTACHMENT_MANIFEST_CAP);
    expect(result.cekRewrappedAttachmentIdsOverflow).toBe(true);
    expect(result.cekRewrapsSucceeded).toBe(count);
  });
});

describe("applyVaultRotation — CAS conflict arms (no write happens)", () => {
  it("rejects when the users row is missing", async () => {
    const { promise, writes } = rotate(baseState({ casRows: [] }));
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });

  it("rejects when the vault was reset mid-flight (vault_setup_at NULL)", async () => {
    const state = baseState({ casRows: [{ key_version: OLD_VERSION, vault_setup_at: null, account_salt: SALT }] });
    const { promise, writes } = rotate(state, payload(), { setupAt: null });
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });

  it("rejects when key_version moved", async () => {
    const state = baseState({
      casRows: [{ key_version: OLD_VERSION + 1, vault_setup_at: new Date(SETUP_AT), account_salt: SALT }],
    });
    const { promise, writes } = rotate(state);
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });

  it("rejects when vault_setup_at differs from the snapshot", async () => {
    const state = baseState({
      casRows: [{ key_version: OLD_VERSION, vault_setup_at: new Date("2026-02-01T00:00:00Z"), account_salt: SALT }],
    });
    const { promise, writes } = rotate(state);
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });

  it("rejects when the snapshot had no vault_setup_at but the row has one", async () => {
    const { promise, writes } = rotate(baseState(), payload(), { setupAt: null });
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });

  it("rejects when account_salt was rewritten by change-passphrase or recover", async () => {
    const { promise, writes } = rotate(baseState(), payload(), { salt: "salt-stale" });
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes).toEqual([]);
  });
});

describe("applyVaultRotation — pre-write guards (no write happens)", () => {
  it("rejects while mode-0 attachments remain", async () => {
    const state = baseState({
      attachments: [mode2Row("a1"), mode2Row("legacy", { encryptionMode: ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY })],
    });
    const { promise, writes } = rotate(state);
    await expect(promise).rejects.toBeInstanceOf(LegacyAttachmentsResidualError);
    expect(writes).toEqual([]);
  });

  it("ignores another user's mode-0 attachments", async () => {
    const state = baseState({
      attachments: [
        mode2Row("a1"),
        mode2Row("other", { userId: OTHER_USER, encryptionMode: ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY }),
      ],
    });
    await expect(rotate(state).promise).resolves.toMatchObject({ mode0Residual: 0 });
  });

  it.each(["cekEncrypted", "cekIv", "cekAuthTag", "cekKeyVersion", "cekWrapAadVersion"] as const)(
    "rejects a mode-2 row whose %s is NULL",
    async (column) => {
      const state = baseState({ attachments: [mode2Row("a1", { [column]: null })] });
      const { promise, writes } = rotate(state);
      await expect(promise).rejects.toBeInstanceOf(Mode2InvariantViolationError);
      expect(writes).toEqual([]);
    },
  );

  it("rejects a manifest id that is not one of the user's mode-2 attachments", async () => {
    const state = baseState({ attachments: [mode2Row("a1"), mode2Row("theirs", { userId: OTHER_USER })] });
    const { promise, writes } = rotate(state, payload({ attachmentCekRewraps: [rewrap("a1"), rewrap("theirs")] }));
    await expect(promise).rejects.toBeInstanceOf(AttachmentCekManifestMismatchError);
    expect(writes).toEqual([]);
  });

  it("rejects a manifest row whose current cekKeyVersion is not the old key version", async () => {
    const state = baseState({ attachments: [mode2Row("a1", { cekKeyVersion: OLD_VERSION - 1 })] });
    const { promise, writes } = rotate(state);
    await expect(promise).rejects.toBeInstanceOf(LegacyAttachmentInconsistentVersionError);
    expect(writes).toEqual([]);
  });

  it("rejects when fewer entries are submitted than the user owns", async () => {
    const p = payload();
    const { promise, writes } = rotate(baseState(), { ...p, entries: p.entries.slice(0, 1) });
    await expect(promise).rejects.toThrow("ENTRY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });

  it("rejects duplicated entry ids even when the count matches", async () => {
    const p = payload();
    const { promise, writes } = rotate(baseState(), { ...p, entries: [p.entries[0], p.entries[0]] });
    await expect(promise).rejects.toThrow("ENTRY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });

  it("rejects a submitted entry id the user does not own", async () => {
    const p = payload();
    const { promise, writes } = rotate(baseState(), {
      ...p,
      entries: [p.entries[0], { ...p.entries[1], id: "foreign" }],
    });
    await expect(promise).rejects.toThrow("ENTRY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });

  it("rejects when the history count differs", async () => {
    const { promise, writes } = rotate(baseState(), payload({ historyEntries: [] }));
    await expect(promise).rejects.toThrow("HISTORY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });

  it("rejects duplicated history ids even when the count matches", async () => {
    const state = baseState({ history: [{ id: "h1", entryUserId: USER }, { id: "h2", entryUserId: USER }] });
    const h = { id: "h1", encryptedBlob: blob, aadVersion: 1 };
    const { promise, writes } = rotate(state, payload({ historyEntries: [h, h] }));
    await expect(promise).rejects.toThrow("HISTORY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });

  it("rejects a submitted history id the user does not own", async () => {
    const { promise, writes } = rotate(
      baseState(),
      payload({ historyEntries: [{ id: "h-other", encryptedBlob: blob, aadVersion: 1 }] }),
    );
    await expect(promise).rejects.toThrow("HISTORY_COUNT_MISMATCH");
    expect(writes).toEqual([]);
  });
});

describe("applyVaultRotation — in-write aborts (no later write happens)", () => {
  it("aborts when an entry update matches no row, before touching history or the user", async () => {
    const { promise, writes } = rotate(baseState({ forceCount: { passwordEntry: 0 } }));
    await expect(promise).rejects.toThrow("ENTRY_COUNT_MISMATCH");
    expect(writes.map((w) => w.model)).toEqual(["passwordEntry"]);
  });

  it("aborts when a history update matches no row, before any CEK or user write", async () => {
    const { promise, writes } = rotate(baseState({ forceCount: { passwordEntryHistory: 0 } }));
    await expect(promise).rejects.toThrow("HISTORY_COUNT_MISMATCH");
    expect(writes.map((w) => w.model)).toEqual(["passwordEntry", "passwordEntry", "passwordEntryHistory"]);
  });

  it("aborts a rewrap with a stale cekWrapAadVersion before writing it", async () => {
    const { promise, writes } = rotate(
      baseState(),
      payload({ attachmentCekRewraps: [rewrap("a1", { cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION + 1 })] }),
    );
    await expect(promise).rejects.toBeInstanceOf(AttachmentCekWrapAadVersionMismatchError);
    expect(writes.some((w) => w.model === "attachment" || w.model === "user")).toBe(false);
  });

  it("aborts when a CEK rewrap matches no row, before the user row is rewritten", async () => {
    const { promise, writes } = rotate(baseState({ forceCount: { attachment: 0 } }));
    await expect(promise).rejects.toBeInstanceOf(AttachmentCekManifestMismatchError);
    expect(writes.at(-1)?.model).toBe("attachment");
    expect(writes.some((w) => w.model === "user")).toBe(false);
  });

  it("maps a VaultKey unique violation to a CAS conflict and writes nothing after it", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    const { promise, writes } = rotate(baseState({ vaultKeyCreateError: p2002 }));
    await expect(promise).rejects.toBeInstanceOf(RotationCasConflictError);
    expect(writes.at(-1)?.model).toBe("vaultKey");
  });

  it("rethrows any other VaultKey create failure unchanged", async () => {
    const other = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" });
    const { promise, writes } = rotate(baseState({ vaultKeyCreateError: other }));
    await expect(promise).rejects.toBe(other);
    expect(writes.at(-1)?.model).toBe("vaultKey");
  });

  it("fails the post-condition when a mode-2 row is left on the old key version", async () => {
    const state = baseState({ attachments: [mode2Row("a1"), mode2Row("unlisted")] });
    const { promise } = rotate(state);
    await expect(promise).rejects.toBeInstanceOf(RotationPostConditionError);
  });
});

// ── applyAttachmentMigration ────────────────────────────────────────────────

const OLD_BODY = new Uint8Array([10, 20, 30]);
const OLD_STORED = new Uint8Array([1, 2, 3]);
const NEW_STORED = new Uint8Array([7, 8, 9]);

function legacyRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return mode2Row("att", {
    passwordEntryId: "entry",
    encryptionMode: ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY,
    encryptedData: new Uint8Array(OLD_STORED),
    keyVersion: 2,
    cekEncrypted: null,
    cekIv: null,
    cekAuthTag: null,
    cekKeyVersion: null,
    cekWrapAadVersion: null,
    ...overrides,
  });
}

function migrationOpts(overrides: Partial<AttachmentMigrationOptions> = {}): AttachmentMigrationOptions {
  return {
    userId: USER,
    tenantId: TENANT,
    entryId: "entry",
    attachmentId: "att",
    payload: {
      oldEncryptedDataHash: createHash("sha256").update(OLD_BODY).digest("hex"),
      encryptedData: "unused",
      iv: "1".repeat(24),
      authTag: "2".repeat(32),
      cekEncrypted: Buffer.from("cek").toString("base64"),
      cekIv: "3".repeat(24),
      cekAuthTag: "4".repeat(32),
      cekKeyVersion: OLD_VERSION,
      cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
    },
    snapshot: { stored: OLD_STORED, body: OLD_BODY, iv: "a".repeat(24), authTag: "b".repeat(32) },
    newStored: NEW_STORED,
    ...overrides,
  };
}

function migrate(rows: AttachmentRow[], opts = migrationOpts(), forceCount?: number) {
  const fake = makeTx(baseState({ attachments: rows, forceCount: forceCount === undefined ? undefined : { attachment: forceCount } }));
  return { ...fake, promise: applyAttachmentMigration(fake.tx, opts) };
}

describe("applyAttachmentMigration", () => {
  it("rewrites a mode-0 attachment to mode 2 and returns the old stored value", async () => {
    const row = legacyRow();
    const { promise } = migrate([row]);

    await expect(promise).resolves.toEqual({
      encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED,
      fromKeyVersion: 2,
      oldStored: OLD_STORED,
    });
    expect(row.encryptionMode).toBe(ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED);
    expect(Buffer.from(row.encryptedData)).toEqual(Buffer.from(NEW_STORED));
    expect(row.cekKeyVersion).toBe(OLD_VERSION);
  });

  it("scopes the update by owner, tenant, entry, personal-only and the iv/authTag CAS", async () => {
    const { promise, writes } = migrate([legacyRow()]);
    await promise;
    expect(writes).toHaveLength(1);
    expect(writes[0].where).toEqual({
      id: "att",
      passwordEntry: { userId: USER, tenantId: TENANT },
      encryptionMode: ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY,
      iv: "a".repeat(24),
      authTag: "b".repeat(32),
      passwordEntryId: "entry",
      teamPasswordEntryId: null,
    });
  });

  it("returns NOT_FOUND for another user's attachment without writing", async () => {
    const { promise, writes } = migrate([legacyRow({ userId: OTHER_USER })]);
    await expect(promise).rejects.toThrow("NOT_FOUND");
    expect(writes).toEqual([]);
  });

  it("returns NOT_FOUND for a team attachment without writing", async () => {
    const { promise, writes } = migrate([legacyRow({ teamPasswordEntryId: "team-entry" })]);
    await expect(promise).rejects.toThrow("NOT_FOUND");
    expect(writes).toEqual([]);
  });

  it("refuses an attachment that is already mode 2", async () => {
    const { promise, writes } = migrate([legacyRow({ encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED })]);
    await expect(promise).rejects.toBeInstanceOf(LegacyMigrationNotApplicableError);
    expect(writes).toEqual([]);
  });

  it("refuses when the row's iv changed since the snapshot", async () => {
    const { promise, writes } = migrate([legacyRow({ iv: "9".repeat(24) })]);
    await expect(promise).rejects.toBeInstanceOf(AttachmentMigrationCasError);
    expect(writes).toEqual([]);
  });

  it("refuses when the row's authTag changed since the snapshot", async () => {
    const { promise, writes } = migrate([legacyRow({ authTag: "9".repeat(32) })]);
    await expect(promise).rejects.toBeInstanceOf(AttachmentMigrationCasError);
    expect(writes).toEqual([]);
  });

  it("refuses when the stored column changed since the snapshot", async () => {
    const { promise, writes } = migrate([legacyRow({ encryptedData: new Uint8Array([1, 2, 4]) })]);
    await expect(promise).rejects.toBeInstanceOf(AttachmentMigrationCasError);
    expect(writes).toEqual([]);
  });

  it("refuses when the supplied hash does not match the stored body", async () => {
    const opts = migrationOpts();
    const { promise, writes } = migrate([legacyRow()], {
      ...opts,
      payload: { ...opts.payload, oldEncryptedDataHash: "0".repeat(64) },
    });
    await expect(promise).rejects.toBeInstanceOf(LegacyBodyHashMismatchError);
    expect(writes).toEqual([]);
  });

  it("refuses when the guarded update matches no row", async () => {
    const { promise, writes } = migrate([legacyRow()], migrationOpts(), 0);
    await expect(promise).rejects.toBeInstanceOf(AttachmentMigrationCasError);
    expect(writes).toHaveLength(1);
  });
});
