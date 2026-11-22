import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { lockTeamAttachmentEntry, lockTeamAttachmentRow } from "./team-attachment-lock";
import { TeamRotationInProgressError } from "./team-key-rotation-lock";

// Raw-SQL transaction fake: answers each $queryRaw by the table it reads and
// records the SQL text and the tagged-template values, so the tests can pin
// which parameter lands in which slot.

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTRY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATTACHMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Query {
  sql: string;
  values: unknown[];
}

interface Rows {
  teams?: unknown[];
  entries?: unknown[];
  attachments?: unknown[];
  teamLockError?: unknown;
}

function makeTx(rows: Rows) {
  const queries: Query[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      queries.push({ sql, values });
      if (sql.includes("current_setting")) return [{ lock_timeout: "0", statement_timeout: "0" }];
      if (sql.includes("FROM teams")) {
        if (rows.teamLockError !== undefined) throw rows.teamLockError;
        return rows.teams ?? [];
      }
      if (sql.includes("FROM team_password_entries")) return rows.entries ?? [];
      if (sql.includes("FROM attachments")) return rows.attachments ?? [];
      throw new Error(`unexpected query: ${sql}`);
    },
    $executeRaw: async () => 1,
  };
  const dataQueries = () => queries.filter((q) => !q.sql.includes("current_setting"));
  return { tx: tx as unknown as Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">, dataQueries };
}

const teamRow = { team_key_version: 5, tenant_id: "tenant-1" };
const entryRow = { item_key_version: 1, item_key_id: "ik-1", team_key_version: 4, created_by_id: "user-1" };

describe("lockTeamAttachmentEntry", () => {
  it("maps the locked team and entry columns to the result", async () => {
    const { tx } = makeTx({ teams: [teamRow], entries: [entryRow] });

    await expect(lockTeamAttachmentEntry(tx, TEAM, ENTRY)).resolves.toEqual({
      teamKeyVersion: 5,
      tenantId: "tenant-1",
      itemKeyVersion: 1,
      itemKeyId: "ik-1",
      entryTeamKeyVersion: 4,
      createdById: "user-1",
    });
  });

  it("locks the team row first, then the entry scoped to that team", async () => {
    const { tx, dataQueries } = makeTx({ teams: [teamRow], entries: [entryRow] });
    await lockTeamAttachmentEntry(tx, TEAM, ENTRY);

    const [teamQuery, entryQuery] = dataQueries();
    expect(teamQuery.sql).toMatch(/FROM teams WHERE id = \?::uuid FOR SHARE/);
    expect(teamQuery.values).toEqual([TEAM]);
    expect(entryQuery.sql).toMatch(/WHERE id = \?::uuid AND team_id = \?::uuid\s+FOR SHARE/);
    expect(entryQuery.values).toEqual([ENTRY, TEAM]);
  });

  it("keeps a null item_key_id as null", async () => {
    const { tx } = makeTx({ teams: [teamRow], entries: [{ ...entryRow, item_key_id: null }] });
    await expect(lockTeamAttachmentEntry(tx, TEAM, ENTRY)).resolves.toMatchObject({ itemKeyId: null });
  });

  it("returns null without querying the entry when the team row is not visible", async () => {
    const { tx, dataQueries } = makeTx({ teams: [], entries: [entryRow] });

    await expect(lockTeamAttachmentEntry(tx, TEAM, ENTRY)).resolves.toBeNull();
    expect(dataQueries()).toHaveLength(1);
  });

  it("returns null when the entry is not in the team", async () => {
    const { tx } = makeTx({ teams: [teamRow], entries: [] });
    await expect(lockTeamAttachmentEntry(tx, TEAM, ENTRY)).resolves.toBeNull();
  });

  it("throws TeamRotationInProgressError when the team lock wait times out", async () => {
    const lockNotAvailable = Object.assign(new Error("lock timeout"), { code: "55P03" });
    const { tx, dataQueries } = makeTx({ teamLockError: lockNotAvailable });

    await expect(lockTeamAttachmentEntry(tx, TEAM, ENTRY)).rejects.toBeInstanceOf(TeamRotationInProgressError);
    expect(dataQueries()).toHaveLength(1);
  });
});

describe("lockTeamAttachmentRow", () => {
  const attachmentRow = {
    filename: "a.pdf",
    content_type: "application/pdf",
    size_bytes: 42,
    encrypted_data: new Uint8Array([1, 2]),
    iv: "iv",
    auth_tag: "tag",
    encryption_mode: 2,
    key_version: null,
  };

  it("maps the locked attachment columns to the result", async () => {
    const { tx } = makeTx({ attachments: [attachmentRow] });

    await expect(lockTeamAttachmentRow(tx, ENTRY, ATTACHMENT)).resolves.toEqual({
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 42,
      encryptedData: new Uint8Array([1, 2]),
      iv: "iv",
      authTag: "tag",
      encryptionMode: 2,
      keyVersion: null,
    });
  });

  it("locks the attachment FOR UPDATE scoped to its entry", async () => {
    const { tx, dataQueries } = makeTx({ attachments: [attachmentRow] });
    await lockTeamAttachmentRow(tx, ENTRY, ATTACHMENT);

    const [query] = dataQueries();
    expect(query.sql).toMatch(/WHERE id = \?::uuid AND team_password_entry_id = \?::uuid\s+FOR UPDATE/);
    expect(query.values).toEqual([ATTACHMENT, ENTRY]);
  });

  it("returns null when the attachment is gone or belongs to another entry", async () => {
    const { tx } = makeTx({ attachments: [] });
    await expect(lockTeamAttachmentRow(tx, ENTRY, ATTACHMENT)).resolves.toBeNull();
  });
});
