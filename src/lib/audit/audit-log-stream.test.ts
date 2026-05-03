import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuditLog } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findMany: vi.fn() } },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
  BYPASS_PURPOSE: { AUDIT_WRITE: "audit_write" },
}));

vi.mock("@/lib/audit/audit-user-lookup", () => ({
  fetchAuditUserMap: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/validations/common.server", () => ({
  AUDIT_LOG_BATCH_SIZE: 2,
  AUDIT_LOG_MAX_ROWS: 5,
}));

import {
  buildAuditLogStream,
  buildAuditLogDownloadResponse,
  type FetchAuditLogBatch,
} from "./audit-log-stream";
import { fetchAuditUserMap } from "@/lib/audit/audit-user-lookup";

const mockedUserMap = vi.mocked(fetchAuditUserMap);

type AuditLogRow = Pick<
  AuditLog,
  "id" | "action" | "targetType" | "targetId" | "ip" | "userAgent" | "createdAt" | "userId" | "actorType" | "metadata"
>;

function makeRow(overrides: Partial<AuditLogRow> & { id: string }): AuditLogRow {
  return {
    id: overrides.id,
    action: overrides.action ?? ("AUTH_LOGIN" as AuditLog["action"]),
    targetType: overrides.targetType ?? null,
    targetId: overrides.targetId ?? null,
    ip: overrides.ip ?? null,
    userAgent: overrides.userAgent ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    userId: overrides.userId ?? "550e8400-e29b-41d4-a716-446655440000",
    actorType: overrides.actorType ?? ("HUMAN" as AuditLog["actorType"]),
    metadata: overrides.metadata ?? null,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let result = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    result += dec.decode(value, { stream: true });
  }
  result += dec.decode();
  return result;
}

describe("buildAuditLogStream — CSV format", () => {
  beforeEach(() => {
    mockedUserMap.mockReset();
    mockedUserMap.mockResolvedValue(new Map());
  });

  it("emits CSV header as first chunk", async () => {
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValue([]);
    const stream = buildAuditLogStream({ format: "csv", fetchBatch });
    const out = await readAll(stream);

    const firstLine = out.split("\n")[0];
    expect(firstLine).toBe(
      "id,action,targetType,targetId,ip,userAgent,createdAt,userId,actorType,userName,userEmail,metadata",
    );
  });

  it("emits one CSV row per audit-log row", async () => {
    // Mocked BATCH_SIZE = 2 (see vi.mock). Returning a single full batch then
    // an empty batch ensures the loop terminates after exactly one iteration.
    const rows = [makeRow({ id: "id-1" }), makeRow({ id: "id-2" })];
    const fetchBatch: FetchAuditLogBatch = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);

    const stream = buildAuditLogStream({ format: "csv", fetchBatch });
    const out = await readAll(stream);
    const lines = out.split("\n").filter(Boolean);

    // header + 2 data rows
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("id-1");
    expect(lines[2]).toContain("id-2");
  });

  it("uses fetched user info for userName / userEmail columns", async () => {
    mockedUserMap.mockResolvedValue(
      new Map([
        ["uid-1", { id: "uid-1", name: "Alice", email: "alice@example.com", image: null }],
      ]),
    );
    const rows = [makeRow({ id: "id-1", userId: "uid-1" })];
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValue(rows);

    const stream = buildAuditLogStream({ format: "csv", fetchBatch });
    const out = await readAll(stream);
    expect(out).toContain('"Alice"');
    expect(out).toContain('"alice@example.com"');
  });
});

describe("buildAuditLogStream — JSONL format", () => {
  beforeEach(() => {
    mockedUserMap.mockReset();
    mockedUserMap.mockResolvedValue(new Map());
  });

  it("does NOT emit a header line", async () => {
    const rows = [makeRow({ id: "id-1" })];
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValue(rows);
    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe("id-1");
  });

  it("includes user object when user info is available", async () => {
    mockedUserMap.mockResolvedValue(
      new Map([["uid-1", { id: "uid-1", name: "Alice", email: "a@example.com", image: null }]]),
    );
    const rows = [makeRow({ id: "id-1", userId: "uid-1" })];
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValue(rows);
    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    const parsed = JSON.parse(out.trim());
    expect(parsed.user).toEqual({ id: "uid-1", name: "Alice", email: "a@example.com" });
  });

  it("emits user: null when user is not in the map (deleted user)", async () => {
    mockedUserMap.mockResolvedValue(new Map());
    const rows = [makeRow({ id: "id-1", userId: "deleted-uid" })];
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValue(rows);
    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    const parsed = JSON.parse(out.trim());
    expect(parsed.user).toBeNull();
  });
});

describe("buildAuditLogStream — pagination cursor", () => {
  beforeEach(() => {
    mockedUserMap.mockReset();
    mockedUserMap.mockResolvedValue(new Map());
  });

  it("paginates with cursor passed as last id of previous batch", async () => {
    const fetchBatch: FetchAuditLogBatch = vi.fn()
      // First batch: full size (BATCH_SIZE = 2 per mock)
      .mockResolvedValueOnce([makeRow({ id: "id-1" }), makeRow({ id: "id-2" })])
      // Second batch: short → terminates
      .mockResolvedValueOnce([makeRow({ id: "id-3" })]);

    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    await readAll(stream);

    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch).toHaveBeenNthCalledWith(1, { take: 2, cursorId: undefined });
    expect(fetchBatch).toHaveBeenNthCalledWith(2, { take: 2, cursorId: "id-2" });
  });

  it("ends stream when fetchBatch returns fewer rows than 'take'", async () => {
    const fetchBatch: FetchAuditLogBatch = vi.fn()
      .mockResolvedValueOnce([makeRow({ id: "id-1" })]); // length < take=2 → stop

    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    expect(fetchBatch).toHaveBeenCalledOnce();
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("ends stream when totalRows reaches AUDIT_LOG_MAX_ROWS (5 per mock)", async () => {
    // Simulate enough rows to hit MAX_ROWS = 5 within BATCH_SIZE = 2
    const fetchBatch: FetchAuditLogBatch = vi.fn()
      .mockResolvedValueOnce([makeRow({ id: "id-1" }), makeRow({ id: "id-2" })])
      .mockResolvedValueOnce([makeRow({ id: "id-3" }), makeRow({ id: "id-4" })])
      .mockResolvedValueOnce([makeRow({ id: "id-5" })]); // remaining=1 → take=1

    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    // The third call should request take=1 (remaining)
    expect(fetchBatch).toHaveBeenNthCalledWith(3, { take: 1, cursorId: "id-4" });
  });

  it("ends stream cleanly when first batch is empty", async () => {
    const fetchBatch: FetchAuditLogBatch = vi.fn().mockResolvedValueOnce([]);
    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    const out = await readAll(stream);

    expect(fetchBatch).toHaveBeenCalledOnce();
    expect(out).toBe(""); // jsonl: no header, no rows
  });
});

describe("buildAuditLogStream — error propagation", () => {
  it("propagates fetchBatch errors as stream errors", async () => {
    const fetchBatch: FetchAuditLogBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("DB connection failed"));

    const stream = buildAuditLogStream({ format: "jsonl", fetchBatch });
    await expect(readAll(stream)).rejects.toThrow("DB connection failed");
  });
});

describe("buildAuditLogDownloadResponse", () => {
  it("uses text/csv content-type for csv format", () => {
    const stream = new ReadableStream<Uint8Array>();
    const res = buildAuditLogDownloadResponse(stream, "csv", "audit-2026-01");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="audit-2026-01.csv"',
    );
  });

  it("uses application/x-ndjson content-type for jsonl format", () => {
    const stream = new ReadableStream<Uint8Array>();
    const res = buildAuditLogDownloadResponse(stream, "jsonl", "audit-2026-01");
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="audit-2026-01.jsonl"',
    );
  });

  it("sets Cache-Control: no-store", () => {
    const stream = new ReadableStream<Uint8Array>();
    const res = buildAuditLogDownloadResponse(stream, "csv", "audit");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
