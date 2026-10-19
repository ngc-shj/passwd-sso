import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NIL_UUID } from "@/lib/constants/app";
import {
  MODEL_TABLE,
  defineGrant,
  readBypassState,
  setBypassGucs,
  setLockTimeout,
  pinBypassOff,
} from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

/** Render a Prisma tagged-template call back to its SQL text and values. */
function captureRaw() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("$"), values });
    return Promise.resolve(0);
  };
  return { calls, tx: { $executeRaw: vi.fn(record) } as unknown as Prisma.TransactionClient };
}

describe("MODEL_TABLE", () => {
  it("maps every Prisma model to its @@map table, as the dmmf does", () => {
    const fromDmmf = Object.fromEntries(
      Prisma.dmmf.datamodel.models.map((m) => [m.name[0].toLowerCase() + m.name.slice(1), m.dbName ?? m.name]),
    );
    expect(MODEL_TABLE).toEqual(fromDmmf);
  });
});

describe("defineGrant", () => {
  it("joins the grant's tables sorted, deduplicated and without spaces", () => {
    const grant = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user", "session", "user"]);
    expect(grant.tables).toBe("sessions,users");
    expect(grant.purpose).toBe("auth_flow");
    expect(Object.isFrozen(grant)).toBe(true);
  });

  it("refuses a grant with no model", () => {
    expect(() => defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [])).toThrow("at least one model");
  });
});

describe("setBypassGucs", () => {
  it("sets the four bypass GUCs transaction-locally in one statement", async () => {
    const { calls, tx } = captureRaw();
    await setBypassGucs(tx, defineGrant(BYPASS_PURPOSE.TOKEN_LIFECYCLE, ["session", "apiKey"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("set_config('app.bypass_rls', 'on', true)");
    expect(calls[0].sql).toContain("set_config('app.bypass_tables', $, true)");
    expect(calls[0].values).toEqual(["token_lifecycle", NIL_UUID, "api_keys,sessions"]);
  });

  it("uses the given tenant id instead of NIL", async () => {
    const { calls, tx } = captureRaw();
    await setBypassGucs(tx, defineGrant(BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH, ["systemSetting"]), {
      tenantId: "00000000-0000-4000-8000-000000000002",
    });
    expect(calls[0].values[1]).toBe("00000000-0000-4000-8000-000000000002");
  });
});

describe("pinBypassOff", () => {
  it("turns the bypass off and clears the grant", async () => {
    const { calls, tx } = captureRaw();
    await pinBypassOff(tx);
    expect(calls[0].sql).toContain("set_config('app.bypass_rls', 'off', true)");
    expect(calls[0].sql).toContain("set_config('app.bypass_tables', '', true)");
  });
});

describe("setLockTimeout", () => {
  it("sets lock_timeout in milliseconds, transaction-locally", async () => {
    const { calls, tx } = captureRaw();
    await setLockTimeout(tx, 200);
    expect(calls[0].sql).toContain("set_config('lock_timeout', $, true)");
    expect(calls[0].values).toEqual(["200ms"]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses %s", async (ms) => {
    const { tx } = captureRaw();
    await expect(setLockTimeout(tx, ms)).rejects.toThrow("positive integer");
  });
});

describe("readBypassState", () => {
  it("returns the four GUCs as read", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ bypass_rls: "on", purpose: "auth_flow", tenant_id: NIL_UUID, tables: "users" }]),
    } as unknown as Prisma.TransactionClient;
    await expect(readBypassState(tx)).resolves.toEqual({
      bypassRls: "on",
      purpose: "auth_flow",
      tenantId: NIL_UUID,
      tables: "users",
    });
  });

  it("returns null when no row comes back, so a caller's check denies", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as Prisma.TransactionClient;
    await expect(readBypassState(tx)).resolves.toBeNull();
  });
});
