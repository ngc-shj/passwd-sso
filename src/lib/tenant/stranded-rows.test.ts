import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { STRANDED_COUNTERS, countStrandedRows } from "./stranded-rows";

/**
 * A client whose every `<model>.count` answers from `counts` (0 when absent),
 * recording the where clause each model was counted with.
 */
function fakeClient(counts: Record<string, number>) {
  const calls = new Map<string, unknown>();
  const client = new Proxy(
    {},
    {
      get: (_target, model: string) => ({
        count: vi.fn(async (args: unknown) => {
          calls.set(model, args);
          return counts[model] ?? 0;
        }),
      }),
    },
  ) as unknown as Prisma.TransactionClient;
  return { client, calls };
}

describe("countStrandedRows", () => {
  it("reports each count under its own model and drops the zeros", async () => {
    const { client } = fakeClient({ passwordEntry: 3, session: 5, webAuthnCredential: 7 });

    const result = await countStrandedRows(client, "user-1", "tenant-1");

    expect(result).toEqual({ passwordEntry: 3, session: 5, webAuthnCredential: 7 });
  });

  it("returns an empty object when nothing is stranded", async () => {
    const { client } = fakeClient({});

    await expect(countStrandedRows(client, "user-1", "tenant-1")).resolves.toEqual({});
  });

  it("counts every model under the user and the released tenant", async () => {
    const { client, calls } = fakeClient({});

    await countStrandedRows(client, "user-1", "tenant-1");

    expect([...calls.keys()].sort()).toEqual(Object.keys(STRANDED_COUNTERS).sort());
    expect(calls.get("operatorToken")).toEqual({ where: { subjectUserId: "user-1", tenantId: "tenant-1" } });
    expect(calls.get("attachment")).toEqual({ where: { createdById: "user-1", tenantId: "tenant-1" } });
  });
});
