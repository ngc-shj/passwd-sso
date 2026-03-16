import { describe, expect, it } from "vitest";
import {
  KDF_PBKDF2_ITERATIONS_MIN,
  KDF_PBKDF2_ITERATIONS_MAX,
  KDF_ARGON2_MEMORY_MIN,
  KDF_ARGON2_MEMORY_MAX,
  PASSKEY_SESSION_MAX_AGE_SECONDS,
  AUDIT_LOG_BATCH_SIZE,
  AUDIT_LOG_MAX_ROWS,
  RATE_WINDOW_MS,
  NOTIFICATION_PAGE_MIN,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_PAGE_MAX,
  SCIM_PAGE_COUNT_MIN,
  SCIM_PAGE_COUNT_DEFAULT,
  SCIM_PAGE_COUNT_MAX,
  IP_ADDRESS_MAX_LENGTH,
  USER_AGENT_MAX_LENGTH,
  SHARE_ACCESS_LOG_LIMIT,
  BREAKGLASS_USER_LIST_LIMIT,
  VAULT_RESET_HISTORY_LIMIT,
  TEAM_MEMBER_SEARCH_LIMIT,
  NOTIFICATION_BELL_LIMIT,
  PASSKEY_DUMMY_CREDENTIALS_MAX,
  PASSWORD_HISTORY_SNIPPET_LENGTH,
} from "@/lib/validations/common.server";

// ─── KDF constants ───────────────────────────────────────────

describe("KDF constants", () => {
  it("KDF_PBKDF2_ITERATIONS_MIN is less than KDF_PBKDF2_ITERATIONS_MAX", () => {
    expect(KDF_PBKDF2_ITERATIONS_MIN).toBeLessThan(KDF_PBKDF2_ITERATIONS_MAX);
  });

  it("KDF_PBKDF2_ITERATIONS_MIN is 600_000 (NIST recommendation)", () => {
    expect(KDF_PBKDF2_ITERATIONS_MIN).toBe(600_000);
  });

  it("KDF_ARGON2_MEMORY_MIN is less than KDF_ARGON2_MEMORY_MAX", () => {
    expect(KDF_ARGON2_MEMORY_MIN).toBeLessThan(KDF_ARGON2_MEMORY_MAX);
  });

  it("KDF_ARGON2_MEMORY_MIN is 16_384 KiB (16 MiB)", () => {
    expect(KDF_ARGON2_MEMORY_MIN).toBe(16_384);
  });

  it("KDF_ARGON2_MEMORY_MAX is 4_194_304 KiB (4 GiB)", () => {
    expect(KDF_ARGON2_MEMORY_MAX).toBe(4_194_304);
  });
});

// ─── Session constants ───────────────────────────────────────

describe("Session constants", () => {
  it("PASSKEY_SESSION_MAX_AGE_SECONDS is 28800 (8 hours)", () => {
    expect(PASSKEY_SESSION_MAX_AGE_SECONDS).toBe(28_800);
  });
});

// ─── Audit log constants ──────────────────────────────────────

describe("Audit log constants", () => {
  it("AUDIT_LOG_BATCH_SIZE is less than AUDIT_LOG_MAX_ROWS", () => {
    expect(AUDIT_LOG_BATCH_SIZE).toBeLessThan(AUDIT_LOG_MAX_ROWS);
  });

  it("AUDIT_LOG_BATCH_SIZE is 500", () => {
    expect(AUDIT_LOG_BATCH_SIZE).toBe(500);
  });

  it("AUDIT_LOG_MAX_ROWS is 100_000", () => {
    expect(AUDIT_LOG_MAX_ROWS).toBe(100_000);
  });
});

// ─── Rate limit constants ────────────────────────────────────

describe("Rate limit constants", () => {
  it("RATE_WINDOW_MS is 60000 (1 minute)", () => {
    expect(RATE_WINDOW_MS).toBe(60_000);
  });
});

// ─── Pagination defaults within min/max ──────────────────────

describe("Notification pagination", () => {
  it("NOTIFICATION_PAGE_MIN is <= NOTIFICATION_PAGE_DEFAULT", () => {
    expect(NOTIFICATION_PAGE_MIN).toBeLessThanOrEqual(NOTIFICATION_PAGE_DEFAULT);
  });

  it("NOTIFICATION_PAGE_DEFAULT is <= NOTIFICATION_PAGE_MAX", () => {
    expect(NOTIFICATION_PAGE_DEFAULT).toBeLessThanOrEqual(NOTIFICATION_PAGE_MAX);
  });

  it("NOTIFICATION_PAGE_MIN is a positive number", () => {
    expect(NOTIFICATION_PAGE_MIN).toBeGreaterThan(0);
  });
});

describe("SCIM pagination", () => {
  it("SCIM_PAGE_COUNT_MIN is <= SCIM_PAGE_COUNT_DEFAULT", () => {
    expect(SCIM_PAGE_COUNT_MIN).toBeLessThanOrEqual(SCIM_PAGE_COUNT_DEFAULT);
  });

  it("SCIM_PAGE_COUNT_DEFAULT is <= SCIM_PAGE_COUNT_MAX", () => {
    expect(SCIM_PAGE_COUNT_DEFAULT).toBeLessThanOrEqual(SCIM_PAGE_COUNT_MAX);
  });

  it("SCIM_PAGE_COUNT_MIN is a positive number", () => {
    expect(SCIM_PAGE_COUNT_MIN).toBeGreaterThan(0);
  });
});

// ─── Network field length constants ──────────────────────────

describe("Network field lengths", () => {
  it("IP_ADDRESS_MAX_LENGTH is 45 (IPv6 max length)", () => {
    expect(IP_ADDRESS_MAX_LENGTH).toBe(45);
  });

  it("USER_AGENT_MAX_LENGTH is 512", () => {
    expect(USER_AGENT_MAX_LENGTH).toBe(512);
  });
});

// ─── Query limit constants ────────────────────────────────────

describe("Query limit constants are positive numbers", () => {
  it.each([
    ["SHARE_ACCESS_LOG_LIMIT", SHARE_ACCESS_LOG_LIMIT],
    ["BREAKGLASS_USER_LIST_LIMIT", BREAKGLASS_USER_LIST_LIMIT],
    ["VAULT_RESET_HISTORY_LIMIT", VAULT_RESET_HISTORY_LIMIT],
    ["TEAM_MEMBER_SEARCH_LIMIT", TEAM_MEMBER_SEARCH_LIMIT],
    ["NOTIFICATION_BELL_LIMIT", NOTIFICATION_BELL_LIMIT],
    ["PASSKEY_DUMMY_CREDENTIALS_MAX", PASSKEY_DUMMY_CREDENTIALS_MAX],
    ["PASSWORD_HISTORY_SNIPPET_LENGTH", PASSWORD_HISTORY_SNIPPET_LENGTH],
  ] as const)("%s is a positive integer", (name, value) => {
    expect(value).toBeGreaterThan(0);
    expect(Number.isInteger(value)).toBe(true);
  });
});
