import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
// String constant: unaffected by the vi.resetModules() dance below, so a
// static import is safe even though the module under test is re-imported.
import { IDENTIFIER_HASH_SCOPE } from "@/lib/audit/auth-failure";
// The real producer — `claimRefusal` is the only thing that can make a
// `ClaimRefusalDiagnosis` (round-6 SEC-R6-3).
import { claimRefusal } from "@/lib/tenant/claim-refusal";

// `getIdentifierPepper`'s memoisation and `warnedNoPepper` flag are frozen at
// first call, module-scope state that survives across tests within the same
// module instance. vitest.config.ts sets isolate:true per FILE (not per
// test), and src/__tests__/setup.ts mandates vi.stubEnv/vi.unstubAllEnvs,
// neither of which reaches a value frozen at first call. Each test therefore
// resets the module registry and re-imports the module under test — the
// pattern already used by src/__tests__/audit-logger.test.ts.
type LoggedAuditCall = { metadata: Record<string, unknown>; tenantId?: string };

const { mockLogAudit } = vi.hoisted(() => ({
  mockLogAudit: vi.fn(async (_params: LoggedAuditCall) => undefined),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockLoggerWarn }),
}));

async function loadAuthFailure() {
  vi.resetModules();
  return import("@/lib/audit/auth-failure");
}

function lastMetadata(): Record<string, unknown> {
  const call = mockLogAudit.mock.calls.at(-1);
  if (!call) throw new Error("logAuditAsync was not called");
  return call[0].metadata;
}

function lastAuditParams(): LoggedAuditCall {
  const call = mockLogAudit.mock.calls.at(-1);
  if (!call) throw new Error("logAuditAsync was not called");
  return call[0];
}

// >= MIN_KEY_MATERIAL_LENGTH (32) — a shorter pepper is treated as absent.
const TEST_PEPPER = "test-pepper-value-of-at-least-32-chars";

describe("emitAuthLoginFailure", () => {
  beforeEach(() => {
    mockLogAudit.mockClear();
    mockLoggerWarn.mockClear();
    // Assert the precondition rather than inherit it: CI's app-ci job sets
    // AUTH_SECRET at job level, which silently moved every "no key material"
    // case onto the HKDF branch (round-1 CR1). "" is falsy at both read sites,
    // so it is a faithful "absent"; setup.ts's vi.unstubAllEnvs() reverts it.
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
    vi.stubEnv("AUTH_SECRET", "");
  });

  it("emits identifierHashScope 'tenant' when tenantId is known", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });

    const metadata = lastMetadata();
    expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.TENANT);
    expect(metadata.identifierHash).not.toBeNull();
  });

  it("emits identifierHashScope 'global' when tenantId is unknown", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "unknown_email",
    });

    const metadata = lastMetadata();
    expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.GLOBAL);
    expect(metadata.identifierHash).not.toBeNull();
  });

  it("emits identifierHash: null and identifierHashScope: null when there is no email at all", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: null,
      provider: "google",
      reason: "unknown_email",
    });

    const metadata = lastMetadata();
    expect(metadata.identifierHash).toBeNull();
    expect(metadata.identifierHashScope).toBeNull();
  });

  it("with an explicit pepper, the hash matches the explicit-key HMAC", async () => {
    const explicit = "explicit-pepper-value-of-at-least-32-chars";
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", explicit);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "USER@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });

    const expected = createHmac("sha256", Buffer.from(explicit, "utf8"))
      .update("user@primary.example:tenant-1")
      .digest("hex")
      .slice(0, 16);

    expect(lastMetadata().identifierHash).toBe(expected);
  });

  it("unset pepper + AUTH_SECRET set: stable, and differs from the empty-key HMAC of the same input", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });
    const first = lastMetadata().identifierHash;

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });
    const second = lastMetadata().identifierHash;

    expect(first).toBe(second);

    const emptyKeyHash = createHmac("sha256", "")
      .update("user@primary.example:tenant-1")
      .digest("hex")
      .slice(0, 16);
    expect(first).not.toBe(emptyKeyHash);
  });

  it("unset pepper + AUTH_SECRET set: differs when AUTH_SECRET differs", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    const { emitAuthLoginFailure: emitWithSecretA } = await loadAuthFailure();
    await emitWithSecretA({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });
    const hashA = lastMetadata().identifierHash;

    vi.stubEnv("AUTH_SECRET", "b".repeat(32));
    const { emitAuthLoginFailure: emitWithSecretB } = await loadAuthFailure();
    await emitWithSecretB({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });
    const hashB = lastMetadata().identifierHash;

    expect(hashA).not.toBe(hashB);
  });

  it("AUTH_SECRET shorter than 32 chars is treated as absent", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(31));
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });

    const metadata = lastMetadata();
    expect(metadata.identifierHash).toBeNull();
    expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.UNKEYED);
  });

  it("AUDIT_IDENTIFIER_PEPPER shorter than 32 chars is treated as absent", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "x");
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });

    const metadata = lastMetadata();
    expect(metadata.identifierHash).toBeNull();
    expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.UNKEYED);
  });

  it("a too-short pepper does not shadow a usable AUTH_SECRET", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "x");
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });

    const oneByteKeyHash = createHmac("sha256", Buffer.from("x", "utf8"))
      .update("user@primary.example:tenant-1")
      .digest("hex")
      .slice(0, 16);

    const metadata = lastMetadata();
    expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.TENANT);
    expect(metadata.identifierHash).not.toBe(oneByteKeyHash);
  });

  it("both unset: identifierHash null, identifierHashScope 'unkeyed', warning emitted once across repeated calls", async () => {
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      tenantId: "tenant-1",
      provider: "google",
      reason: "tenant_mismatch",
    });
    await emitAuthLoginFailure({
      email: "other@primary.example",
      tenantId: "tenant-2",
      provider: "google",
      reason: "tenant_mismatch",
    });

    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    for (const call of mockLogAudit.mock.calls) {
      const metadata = call[0].metadata;
      expect(metadata.identifierHash).toBeNull();
      expect(metadata.identifierHashScope).toBe(IDENTIFIER_HASH_SCOPE.UNKEYED);
    }
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it("the warning fires on first derivation, not at module load", async () => {
    const { emitAuthLoginFailure } = await loadAuthFailure();
    // Import alone must not have warned yet.
    expect(mockLoggerWarn).not.toHaveBeenCalled();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "unknown_email",
    });
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it("claim appears in metadata, truncated at MAX_TENANT_CLAIM_LENGTH", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();
    const { MAX_TENANT_CLAIM_LENGTH } = await import("@/lib/validations/common.server");

    const overlong = "a".repeat(MAX_TENANT_CLAIM_LENGTH + 50);
    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_claim_unmapped",
      claim: overlong,
    });

    const metadata = lastMetadata();
    expect(metadata.claim).toBe(overlong.slice(0, MAX_TENANT_CLAIM_LENGTH));
    expect((metadata.claim as string).length).toBe(MAX_TENANT_CLAIM_LENGTH);
  });

  /**
   * Round-5 T1. `.toWellFormed()` was added in round 4 as the guard against an
   * audit-suppression primitive — a lone surrogate makes the jsonb write fail
   * with 22P02 and logAuditAsync swallows the whole row — and it shipped with
   * NO test: removing it left 388 tests in this directory green, because the
   * only fixture that reached the slice was pure ASCII, on which the call is a
   * no-op.
   *
   * The path is live independently of the refusal rendering round 4 removed:
   * an ingest-valid claim can carry a lone surrogate (that arm now refuses it,
   * but this is the shared boundary EVERY caller crosses, and nothing enforces
   * the precondition the bare slice's safety rested on).
   */
  it("makes a claim truncated mid-surrogate-pair well-formed", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();
    const { MAX_TENANT_CLAIM_LENGTH } = await import("@/lib/validations/common.server");

    // The astral character straddles the cap, so a bare slice leaves its high
    // surrogate as the final code unit.
    const straddling = "a".repeat(MAX_TENANT_CLAIM_LENGTH - 1) + "\u{1F600}" + "x";
    expect(straddling.slice(0, MAX_TENANT_CLAIM_LENGTH).isWellFormed()).toBe(false);

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_claim_unmapped",
      claim: straddling,
    });

    const claim = lastMetadata().claim as string;
    expect(claim.isWellFormed()).toBe(true);
    expect(claim.length).toBe(MAX_TENANT_CLAIM_LENGTH);
  });

  it("makes a claim carrying an interior lone surrogate well-formed", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_claim_unmapped",
      claim: "acme\uD83D.example",
    });

    const claim = lastMetadata().claim as string;
    expect(claim.isWellFormed()).toBe(true);
    expect(claim).not.toContain("\uD83D");
  });

  /**
   * Round-5 S2: the refusal diagnosis has its own key, so an operator (and
   * `tenant-domain unmapped`) can tell a machine-generated refusal from a
   * value the IdP asserted — including one asserted AS a refusal string.
   *
   * Round-6 SEC-R6-3: the value comes from the REAL producer. The parameter is
   * branded, so a string literal no longer type-checks here — which is the
   * enforcement, and it also means the `refused: ` prefix asserted below is
   * production's spelling rather than this file's copy of it.
   */
  it("records a refusal diagnosis under its own key, leaving claim untouched", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_mismatch",
      claimRefusal: claimRefusal("contains U+200B"),
    });

    const metadata = lastMetadata();
    expect(metadata.claimRefusal).toBe("refused: contains U+200B");
    expect(metadata.claim).toBeUndefined();
  });

  it("keeps a forged refusal string in claim, where it cannot be mistaken for the real field", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    // The exact string an actor can assert as their claim (verified against
    // the real ingest boundary). It must land in `claim`, never in
    // `claimRefusal`, or the discriminator is forgeable again.
    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_claim_unmapped",
      claim: "refused: contains U+200B",
    });

    const metadata = lastMetadata();
    expect(metadata.claim).toBe("refused: contains U+200B");
    expect(metadata.claimRefusal).toBeUndefined();
  });

  it("claim is omitted from metadata when not supplied", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@primary.example",
      provider: "google",
      reason: "tenant_mismatch",
    });

    expect(lastMetadata()).not.toHaveProperty("claim");
  });
});

// Round-3 Critical. The tenant binding has to survive the hop from
// emitAuthLoginFailure into logAuditAsync, not just be accepted as an
// argument. resolveTenantId returns params.tenantId directly when present;
// when it is absent it falls back to a users lookup on the caller's userId —
// and for a claim refusal on a FIRST-EVER sign-in that userId is
// SYSTEM_ACTOR_ID, for which no users row exists, so logAuditAsync
// dead-letters and writes neither an audit_logs nor an audit_outbox row.
// The denial then stays invisible to `tenant-domain unmapped`, which groups
// by tenant_id on both tables. Round 2 wired the tenant all the way to this
// function and asserted the emit's arguments against a mocked module — which
// is precisely why the dropped hop went unnoticed for a whole round.
describe("emitAuthLoginFailure — tenant binding reaches logAuditAsync", () => {
  it("forwards a supplied tenantId so the row can be bound and enqueued", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@alias.example",
      tenantId: "tenant-owner",
      provider: "google",
      reason: "tenant_claim_unmapped",
      claim: "alias.example",
    });

    expect(lastAuditParams().tenantId).toBe("tenant-owner");
  });

  it("omits tenantId when the caller has no tenant, leaving resolveTenantId to try", async () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", TEST_PEPPER);
    const { emitAuthLoginFailure } = await loadAuthFailure();

    await emitAuthLoginFailure({
      email: "user@alias.example",
      provider: "google",
      reason: "unknown_email",
    });

    // undefined, never null: AuditLogParams.tenantId is optional, and a null
    // would make resolveTenantId's `if (params.tenantId)` short-circuit differ
    // from its documented contract.
    expect(lastAuditParams().tenantId).toBeUndefined();
  });
});
