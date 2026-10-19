/**
 * A refused RLS nesting is logged before it throws, so a caller that swallows
 * the error (best-effort notification, lockout audit) still leaves a record.
 * The log names the two helpers and nothing the caller supplied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { mockError, mockGetLogger, workingLogger } = vi.hoisted(() => {
  const mockError = vi.fn();
  const workingLogger = () => ({ error: mockError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() });
  return { mockError, mockGetLogger: vi.fn(workingLogger), workingLogger };
});

vi.mock("@/lib/logger", () => ({ getLogger: mockGetLogger }));

import { withTenantRls, withBypassRls, BYPASS_PURPOSE, RlsSentinelContextRefused } from "@/lib/tenant-rls";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

const TENANT_ID = "77777777-7777-4777-8777-777777777777";

function makePrisma() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(undefined) };
  return {
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
}

beforeEach(() => {
  mockError.mockReset();
  mockGetLogger.mockReset();
  mockGetLogger.mockImplementation(workingLogger);
});

describe("RLS nesting refusal log", () => {
  it("does not log when no RLS context is active", async () => {
    await withTenantRls(makePrisma(), TENANT_ID, async () => undefined);
    expect(mockError).not.toHaveBeenCalled();
  });

  it("logs a structured error naming both helpers, then throws INVALID_RLS_NESTING", async () => {
    const prisma = makePrisma();
    await expect(
      withTenantRls(prisma, TENANT_ID, () =>
        withBypassRls(prisma, async () => undefined, BYPASS_PURPOSE.AUDIT_WRITE),
      ),
    ).rejects.toThrow("INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden");

    expect(mockError).toHaveBeenCalledOnce();
    const [fields, message] = mockError.mock.calls[0];
    expect(fields).toEqual({ event: "rls.nesting_refused", opening: "withBypassRls", active: "withTenantRls" });
    expect(message).toBe("RLS context refused: another RLS context is active");
  });

  it("logs the refusal even when the caller swallows the error", async () => {
    const prisma = makePrisma();
    await withBypassRls(
      prisma,
      async () => {
        await withTenantRls(prisma, TENANT_ID, async () => undefined).catch(() => null);
      },
      BYPASS_PURPOSE.AUDIT_WRITE,
    );
    expect(mockError).toHaveBeenCalledOnce();
    expect(mockError.mock.calls[0][0]).toEqual({
      event: "rls.nesting_refused",
      opening: "withTenantRls",
      active: "withBypassRls",
    });
    // Nothing the caller supplied reaches the log.
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(TENANT_ID);
  });
});

// The refusal is the control; the log is its record. A logger that fails must
// not replace the refusal with its own error, or a caller matching on it (or
// on RlsSentinelContextRefused) would no longer see one.
const LOGGER_STATES: [string, () => void][] = [
  ["the logger works", () => {}],
  ["getLogger() throws", () => mockGetLogger.mockImplementation(() => { throw new Error("logger unavailable"); })],
  ["logger.error throws", () => mockError.mockImplementation(() => { throw new Error("log sink failed"); })],
];

describe("a logger failure does not change the refusal", () => {
  it.each(LOGGER_STATES)("refuses a nested context with INVALID_RLS_NESTING when %s, and never opens it", async (_label, arrange) => {
    arrange();
    const prisma = makePrisma();
    const inner = vi.fn(async () => undefined);
    await expect(
      withTenantRls(prisma, TENANT_ID, () => withBypassRls(prisma, inner, BYPASS_PURPOSE.AUDIT_WRITE)),
    ).rejects.toThrow("INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden");
    // Only the outer context's transaction was opened.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it.each(LOGGER_STATES)("refuses the sentinel tenant with RlsSentinelContextRefused when %s, and opens no transaction", async (_label, arrange) => {
    arrange();
    const prisma = makePrisma();
    const fn = vi.fn(async () => undefined);
    await expect(withTenantRls(prisma, SYSTEM_TENANT_ID, fn)).rejects.toBeInstanceOf(RlsSentinelContextRefused);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
