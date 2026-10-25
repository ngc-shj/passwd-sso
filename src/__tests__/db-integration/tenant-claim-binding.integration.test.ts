/**
 * Real-DB coverage for claim provenance and the binding adjudicator — plan
 * sso-claim-connection-binding, C3 (schema), C4 and C5.
 *
 * Every sign-in cell runs through a production entry point on the app role:
 * the real signIn callback (captured from the `NextAuth(...)` config) for an
 * existing user, and the callback followed by the adapter's `createUser`, both
 * under `tenantClaimStorage.run`, for a first-ever sign-in — the order Auth.js
 * calls them in. The binding mode is never passed in: each cell stubs the env
 * and the code under test derives it, as production does.
 *
 * The outbox worker must be stopped (setup.ts refuses otherwise), so a denial's
 * audit row is read from `audit_outbox`, the upstream table.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const { nextAuthConfigs } = vi.hoisted(() => ({ nextAuthConfigs: [] as unknown[] }));

// See audit-sentinel-claim-denial.integration.test.ts for why `next-auth`
// itself is mocked. The config handed to it is kept: its signIn callback is
// the production entry point the existing-user cells drive.
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthConfigs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import {
  createPrismaForRole,
  createTestContext,
  raceTwoClients,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import {
  runToken,
  stubClaimProviderEnv,
  type ProviderEnvSpec,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import "@/auth";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { sessionMetaStorage, type SessionMeta } from "@/lib/auth/session/session-meta";
import { findOrCreateTenantForClaim, type ClaimTenantResolution } from "@/lib/tenant/tenant-management";
import {
  CLAIM_BINDING_MODE,
  PROVIDER_ID_PATTERN,
  isProviderIdShape,
  type ClaimBindingMode,
} from "@/lib/auth/jackson-providers";
import { providerRef, resetIdentifierPepperForTests } from "@/lib/audit/identifier-pepper";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { DEREGISTER_ACTOR_LABEL, TENANT_CLAIM_EVENT_OPERATION } from "@/lib/tenant/tenant-claim-event";
import * as loggerModule from "@/lib/logger";
import {
  MIGRATED_COUNTERS,
  MIGRATION_TREATMENT,
  type MigratedCounterHandle,
  type NonCounterWriteHandle,
} from "@/__tests__/helpers/bootstrap-migration-set";

type SignInParams = {
  user: { id?: string; email?: string | null };
  account: { provider: string; type: "oidc"; providerAccountId: string } | null;
  profile: Record<string, unknown> | null;
};
type SignInCallback = (params: SignInParams) => Promise<boolean>;

function capturedSignIn(): SignInCallback {
  const config = nextAuthConfigs[0] as { callbacks?: { signIn?: SignInCallback } } | undefined;
  const signIn = config?.callbacks?.signIn;
  if (!signIn) throw new Error("src/auth.ts did not hand NextAuth a signIn callback");
  return signIn;
}

const PEPPER = "binding-integration-pepper-0123456789abcdef";
/** The provider every grid sign-in presents. */
const SIGN_IN_PROVIDER = "saml-jackson-alpha";
/** Another customer's connection: a row bound here is "bound-other". */
const OTHER_PROVIDER = "saml-jackson-bravo";

/**
 * The env each mode is derived from, as a deployment that runs in it is
 * configured: off is one claim provider, strict is two (strict is then forced,
 * and set, as the boot check requires).
 */
const MODE_ENV = {
  off: { connections: [SIGN_IN_PROVIDER] },
  strict: { connections: [SIGN_IN_PROVIDER, OTHER_PROVIDER], mode: CLAIM_BINDING_MODE.STRICT },
} as const satisfies Record<ClaimBindingMode, ProviderEnvSpec>;

function stubModeEnv(mode: ClaimBindingMode): void {
  stubClaimProviderEnv(MODE_ENV[mode]);
}

const ROW_STATE = {
  BOUND_SAME: "bound-same",
  BOUND_OTHER: "bound-other",
  UNBOUND: "unbound",
} as const;
type RowState = (typeof ROW_STATE)[keyof typeof ROW_STATE];

const ROW_PROVIDER = {
  "bound-same": SIGN_IN_PROVIDER,
  "bound-other": OTHER_PROVIDER,
  unbound: null,
} as const satisfies Record<RowState, string | null>;

type Expected =
  | { kind: "allow" }
  | { kind: "refuse"; reason: "tenant_claim_unbound" | "tenant_claim_provider_mismatch" };

/** The grid's verdicts (row state × mode); the path must not change them. */
const VERDICT = {
  off: {
    "bound-same": { kind: "allow" },
    "bound-other": { kind: "allow" },
    unbound: { kind: "allow" },
  },
  strict: {
    "bound-same": { kind: "allow" },
    "bound-other": { kind: "refuse", reason: "tenant_claim_provider_mismatch" },
    unbound: { kind: "refuse", reason: "tenant_claim_unbound" },
  },
} as const satisfies Record<ClaimBindingMode, Record<RowState, Expected>>;

const PATH = { EXISTING_USER: "existing-user", FIRST_SIGN_IN: "first-sign-in" } as const;
type Path = (typeof PATH)[keyof typeof PATH];

type OutboxRow = { tenant_id: string; metadata: Record<string, unknown>; row_text: string };

describe("tenant claim binding (C3/C4/C5)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", PEPPER);
    resetIdentifierPepperForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetIdentifierPepperForTests();
  });

  function freshClaim(arm: string): string {
    return `bind-${arm}-${runToken()}.example`;
  }

  async function bindClaim(tenantId: string, claim: string, provider: string | null): Promise<void> {
    await ctx.su.prisma.tenantClaim.create({
      data: { tenantId, claim, createdBy: "binding-integration-test", provider },
    });
  }

  async function outboxRowsForClaim(claim: string): Promise<OutboxRow[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT tenant_id::text, payload->'metadata' AS metadata, row_to_json(o)::text AS row_text
           FROM audit_outbox o
          WHERE payload->>'action' = 'AUTH_LOGIN_FAILURE'
            AND payload->'metadata'->>'claim' = $1`,
        claim,
      );
    });
  }

  /** Every row a sign-in could have written for this claim, user and owner. */
  async function snapshot(claim: string, email: string, ownerTenantId: string) {
    const [row] = await ctx.su.prisma.$queryRaw<
      { users: bigint; tenants: bigint; members: bigint; claims: bigint; events: bigint }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM users WHERE email = ${email})::bigint AS users,
        (SELECT COUNT(*) FROM tenants WHERE name = ${claim})::bigint AS tenants,
        (SELECT COUNT(*) FROM tenant_members WHERE tenant_id = ${ownerTenantId}::uuid)::bigint AS members,
        (SELECT COUNT(*) FROM tenant_claims WHERE claim = ${claim})::bigint AS claims,
        (SELECT COUNT(*) FROM tenant_claim_events WHERE claim = ${claim})::bigint AS events
    `;
    return {
      users: Number(row!.users),
      tenants: Number(row!.tenants),
      members: Number(row!.members),
      claims: Number(row!.claims),
      events: Number(row!.events),
    };
  }

  async function emailOf(userId: string): Promise<string> {
    const user = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    if (!user.email) throw new Error("fixture user has no email");
    return user.email;
  }

  /**
   * `providerAccountId` defaults to a fresh, unlinked subject — a first-ever
   * sign-in. An existing user signs in through an account linked to them
   * (`linkAccount`): Auth.js refuses an unlinked one whose email names a user,
   * and so does the callback, before any write.
   */
  function signInParams(
    email: string,
    claim: string,
    provider = SIGN_IN_PROVIDER,
    providerAccountId = `subject-${randomUUID()}`,
  ): SignInParams {
    return {
      user: { id: "pre-generated-id", email },
      account: { provider, type: "oidc", providerAccountId },
      profile: { tenant_id: claim },
    };
  }

  /** Link a provider account to a user, as Auth.js's linkAccount would; returns its subject. */
  async function linkAccount(userId: string, tenantId: string, provider = SIGN_IN_PROVIDER): Promise<string> {
    const providerAccountId = `subject-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO accounts (id, user_id, tenant_id, type, provider, provider_account_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'oidc', $4, $5)`,
        randomUUID(),
        userId,
        tenantId,
        provider,
        providerAccountId,
      );
    });
    return providerAccountId;
  }

  /** End the user's active membership: the state a departed member signs in from (row 4/8). */
  async function deactivateMemberships(userId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid AND deactivated_at IS NULL`,
        userId,
      );
    });
  }

  /**
   * A row-4/8 join moves the user's column but not their accounts or sessions,
   * which keep the old tenant and would block its teardown (both tenant FKs
   * are RESTRICT); deleteTestData sweeps neither by tenant.
   */
  async function dropAuthRows(userId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE user_id = $1::uuid`, userId);
      await tx.$executeRawUnsafe(`DELETE FROM accounts WHERE user_id = $1::uuid`, userId);
    });
  }

  async function tenantOf(userId: string): Promise<string> {
    const user = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    return user.tenantId;
  }

  /** A user of `tenantId` with an account linked through `provider`. */
  async function existingUser(tenantId: string, provider = SIGN_IN_PROVIDER) {
    const userId = await ctx.createUser(tenantId);
    return { userId, email: await emailOf(userId), providerAccountId: await linkAccount(userId, tenantId, provider) };
  }

  /**
   * A first-ever sign-in as Auth.js runs it: the signIn callback stores the
   * claim, then the adapter creates the user. Returns whether it was allowed.
   */
  async function firstSignIn(email: string, claim: string, provider = SIGN_IN_PROVIDER): Promise<boolean> {
    const meta: SessionMeta = { ip: null, userAgent: null, acceptLanguage: null, provider: null };
    return sessionMetaStorage.run(meta, () =>
      tenantClaimStorage.run({ tenantClaim: null, provider: null }, async () => {
        const allowed = await capturedSignIn()(signInParams(email, claim, provider));
        if (!allowed) return false;
        const createUser = createCustomAdapter().createUser;
        if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
        try {
          await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          return true;
        } catch (error) {
          if (error instanceof Error && error.message === "TENANT_CLAIM_UNUSABLE") return false;
          throw error;
        }
      }),
    );
  }

  /**
   * The subject of a grid sign-in, created before the sign-in so a snapshot
   * taken after it measures the sign-in alone. A first-ever sign-in has no
   * user yet, only the email it will arrive with.
   */
  async function subjectFor(path: Path, ownerTenantId: string) {
    if (path === PATH.EXISTING_USER) return existingUser(ownerTenantId);
    return { email: `bind-${randomUUID()}@example.invalid`, providerAccountId: undefined };
  }

  async function signIn(
    path: Path,
    claim: string,
    subject: { email: string; providerAccountId: string | undefined },
  ): Promise<boolean> {
    if (path === PATH.EXISTING_USER) {
      return capturedSignIn()(signInParams(subject.email, claim, SIGN_IN_PROVIDER, subject.providerAccountId));
    }
    return firstSignIn(subject.email, claim);
  }

  const GRID = (Object.keys(VERDICT) as ClaimBindingMode[]).flatMap((mode) =>
    (Object.values(ROW_STATE) as RowState[]).flatMap((rowState) =>
      (Object.values(PATH) as Path[]).map((path) => [mode, rowState, path] as const),
    ),
  );

  it.each(GRID)("%s mode, %s row, %s", async (mode, rowState, path) => {
    stubModeEnv(mode);
    const owner = await ctx.createTenant();
    const claim = freshClaim(`${mode}-${rowState}-${path}`);
    await bindClaim(owner, claim, ROW_PROVIDER[rowState]);
    try {
      const expected: Expected = VERDICT[mode][rowState];
      const subject = await subjectFor(path, owner);
      const before = await snapshot(claim, subject.email, owner);
      const allowed = await signIn(path, claim, subject);
      const after = await snapshot(claim, subject.email, owner);

      if (expected.kind === "allow") {
        expect(allowed).toBe(true);
        // A delta, not a count: the existing user was already a member, so
        // "one membership" held before the sign-in ran. Their sign-in changes
        // nothing (row 5); a first-ever one adds exactly the user and their
        // membership, under the claim's existing row.
        expect(after).toEqual(
          path === PATH.EXISTING_USER
            ? before
            : { ...before, users: before.users + 1, members: before.members + 1 },
        );
        const member = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM tenant_members m JOIN users u ON u.id = m.user_id
           WHERE u.email = ${subject.email} AND m.tenant_id = ${owner}::uuid AND m.deactivated_at IS NULL
        `;
        expect(Number(member[0]!.n)).toBe(1);
        expect(await outboxRowsForClaim(claim)).toHaveLength(0);
        return;
      }

      expect(allowed).toBe(false);
      expect(after).toEqual(before);

      const rows = await outboxRowsForClaim(claim);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.tenant_id).toBe(owner);
      expect(row.metadata.reason).toBe(expected.reason);
      expect(row.metadata.signInProviderRef).toBe(providerRef(SIGN_IN_PROVIDER, Buffer.from(PEPPER, "utf8")));
      expect(row.metadata).toHaveProperty("boundProvider", ROW_PROVIDER[rowState]);
      // The raw sign-in provider id appears nowhere in the row, while the
      // raw bound provider (that tenant's own binding) does — the control
      // that the text search can see a provider id at all.
      expect(row.row_text).not.toContain(SIGN_IN_PROVIDER);
      if (rowState === ROW_STATE.BOUND_OTHER) expect(row.row_text).toContain(OTHER_PROVIDER);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  /**
   * An existing user presenting a claim nobody has registered: row 8, the user
   * has no active membership, so the sign-in creates the tenant and the claim
   * and joins it. The row is bound to the presenting provider in either mode —
   * the existing-user twin of the first-registration cell below, through
   * `ensureTenantMembershipForSignIn` rather than `createUser`. A bootstrap
   * member's twin (row 9a) is in the bootstrap-migration block below.
   */
  it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
    "%s mode, existing user with no active membership, unregistered claim: registered to the presenting provider",
    async (mode) => {
      stubModeEnv(mode);
      const home = await ctx.createTenant();
      const claim = freshClaim(`existing-register-${mode}`);
      let created: string | null = null;
      const user = await existingUser(home);
      try {
        await deactivateMemberships(user.userId);

        expect(
          await capturedSignIn()(signInParams(user.email, claim, SIGN_IN_PROVIDER, user.providerAccountId)),
        ).toBe(true);

        const row = await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim } });
        created = row.tenantId;
        ctx.trackTenant(created);
        expect(row.provider).toBe(SIGN_IN_PROVIDER);
        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          newProvider: SIGN_IN_PROVIDER,
        });
        expect(await tenantOf(user.userId)).toBe(created);
      } finally {
        await dropAuthRows(user.userId);
        await ctx.deleteTestData(home);
        if (created) await ctx.deleteTestData(created);
      }
    },
  );

  it("strict, Google: a row bound to google resolves a google sign-in", async () => {
    stubClaimProviderEnv({ google: true, connections: [SIGN_IN_PROVIDER], mode: CLAIM_BINDING_MODE.STRICT });
    const owner = await ctx.createTenant();
    const claim = freshClaim("google-strict");
    await bindClaim(owner, claim, "google");
    try {
      const email = `bind-${randomUUID()}@example.invalid`;
      expect(await firstSignIn(email, claim, "google")).toBe(true);
      const user = await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } });
      expect(user?.tenantId).toBe(owner);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
    "%s mode: first registration binds the claim to the presenting provider, row and event",
    async (mode) => {
      stubModeEnv(mode);
      const claim = freshClaim(`register-${mode}`);
      const email = `bind-${randomUUID()}@example.invalid`;
      let created: string | null = null;
      try {
        expect(await firstSignIn(email, claim)).toBe(true);
        const row = await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim } });
        created = row.tenantId;
        ctx.trackTenant(created);
        expect(row.provider).toBe(SIGN_IN_PROVIDER);
        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldProvider: null,
          newProvider: SIGN_IN_PROVIDER,
        });
      } finally {
        if (created) await ctx.deleteTestData(created);
      }
    },
  );

  it("without a pepper the refusal row stores no ref, and still names the binding", async () => {
    stubModeEnv(CLAIM_BINDING_MODE.STRICT);
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
    vi.stubEnv("AUTH_SECRET", "");
    resetIdentifierPepperForTests();
    const owner = await ctx.createTenant();
    const claim = freshClaim("no-pepper");
    await bindClaim(owner, claim, OTHER_PROVIDER);
    try {
      expect(await firstSignIn(`bind-${randomUUID()}@example.invalid`, claim)).toBe(false);
      const [row] = await outboxRowsForClaim(claim);
      expect(row?.metadata.reason).toBe("tenant_claim_provider_mismatch");
      expect(row?.metadata.boundProvider).toBe(OTHER_PROVIDER);
      expect(row?.metadata).not.toHaveProperty("signInProviderRef");
      expect(row?.row_text).not.toContain(SIGN_IN_PROVIDER);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  /**
   * The members the S1 and bootstrap-migration cells sign in as: a departed
   * member (no active membership) and a bootstrap member, each with a row in
   * every table the bootstrap migration moves and the account they signed up
   * through.
   */
  const VICTIM_STATE = { DEPARTED: "departed member", BOOTSTRAP: "bootstrap member" } as const;
  type VictimState = (typeof VICTIM_STATE)[keyof typeof VICTIM_STATE];

  type Victim = { userId: string; email: string; home: string };

  /** Ids one `seedOwnedRows` call shares across its tables, so a child row can name its parent. */
  type SeedIds = {
    readonly userId: string;
    readonly tenantId: string;
    readonly entryId: string;
    readonly grantId: string;
    readonly shareId: string;
    readonly mcpClientId: string;
    readonly mcpTokenId: string;
  };
  type Sql = (text: string, ...values: unknown[]) => Promise<number>;
  /**
   * One table the bootstrap migration writes. `select` reads the tenant of the
   * user's rows (`$1` = the user id); a table the migration revokes rather than
   * moves appends " revoked" to a revoked row's tenant, so "left in place and
   * revoked" and "moved" read differently. `seed` inserts one row of the
   * user's, or is null where `createUser`/`linkAccount` already did.
   */
  type OwnedTable = {
    readonly select: string;
    readonly seed: ((sql: Sql, ids: SeedIds) => Promise<number>) | null;
  };

  const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
  const IV = "0".repeat(24);
  const TAG = "0".repeat(32);
  const revocable = (table: string, column: string, userColumn = "user_id") =>
    `SELECT tenant_id::text || CASE WHEN ${column} IS NULL THEN '' ELSE ' revoked' END AS tenant_id
       FROM ${table} WHERE ${userColumn} = $1::uuid`;

  /**
   * Every counter the migration migrates, keyed by `MigratedCounterHandle`:
   * a counter added to `STRANDED_COUNTERS` does not compile here until it is
   * classified in `bootstrap-migration-set.ts` and, if migrated, given a row.
   * Seeded in this order, parents first.
   */
  const COUNTER_TABLES: Record<MigratedCounterHandle, OwnedTable> = {
    account: { select: `SELECT tenant_id FROM accounts WHERE user_id = $1::uuid`, seed: null },
    passwordEntry: {
      select: `SELECT tenant_id FROM password_entries WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO password_entries (
             id, user_id, tenant_id,
             encrypted_blob, blob_iv, blob_auth_tag,
             encrypted_overview, overview_iv, overview_auth_tag,
             key_version, aad_version, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'blob', $4, $5, 'overview', $4, $5, 1, 1, now(), now())`,
          ids.entryId, ids.userId, ids.tenantId, IV, TAG,
        ),
    },
    emergencyAccessGrant: {
      select: `SELECT tenant_id FROM emergency_access_grants WHERE owner_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO emergency_access_grants (id, tenant_id, owner_id, grantee_email, wait_days, token_hash, token_expires_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'grantee@example.invalid', 7, $4, now() + interval '1 day', now())`,
          ids.grantId, ids.tenantId, ids.userId, hex(32),
        ),
    },
    passwordShare: {
      select: `SELECT tenant_id FROM password_shares WHERE created_by_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO password_shares (id, tenant_id, token_hash, encrypted_data, data_iv, data_auth_tag, expires_at, created_by_id, password_entry_id)
           VALUES ($1::uuid, $2::uuid, $3, 'data', $4, $5, now() + interval '1 day', $6::uuid, $7::uuid)`,
          ids.shareId, ids.tenantId, hex(32), IV, TAG, ids.userId, ids.entryId,
        ),
    },
    session: {
      select: `SELECT tenant_id FROM sessions WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
          randomUUID(), hex(16), ids.userId, ids.tenantId,
        ),
    },
    tag: {
      select: `SELECT tenant_id FROM tags WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO tags (id, name, user_id, tenant_id, created_at, updated_at)
           VALUES ($1::uuid, 'tag', $2::uuid, $3::uuid, now(), now())`,
          randomUUID(), ids.userId, ids.tenantId,
        ),
    },
    folder: {
      select: `SELECT tenant_id FROM folders WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO folders (id, name, user_id, tenant_id, created_at, updated_at)
           VALUES ($1::uuid, 'folder', $2::uuid, $3::uuid, now(), now())`,
          randomUUID(), ids.userId, ids.tenantId,
        ),
    },
    extensionToken: {
      select: `SELECT tenant_id FROM extension_tokens WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, expires_at, family_id, cnf_jkt)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'passwords:read', now() + interval '1 day', $5::uuid, $6)`,
          randomUUID(), ids.userId, ids.tenantId, hex(32), randomUUID(), hex(16),
        ),
    },
    vaultKey: {
      select: `SELECT tenant_id FROM vault_keys WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO vault_keys (id, user_id, tenant_id, version, verification_ciphertext, verification_iv, verification_auth_tag)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'verify', $4, $5)`,
          randomUUID(), ids.userId, ids.tenantId, IV, TAG,
        ),
    },
    attachment: {
      select: `SELECT tenant_id FROM attachments WHERE created_by_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO attachments (id, filename, content_type, size_bytes, encrypted_data, iv, auth_tag, tenant_id, password_entry_id, created_by_id)
           VALUES ($1::uuid, 'a.bin', 'application/octet-stream', 1, '\\x00'::bytea, $2, $3, $4::uuid, $5::uuid, $6::uuid)`,
          randomUUID(), IV, TAG, ids.tenantId, ids.entryId, ids.userId,
        ),
    },
    notification: {
      select: `SELECT tenant_id FROM notifications WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO notifications (id, user_id, tenant_id, type, title, body)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'SECURITY_ALERT', 'title', 'body')`,
          randomUUID(), ids.userId, ids.tenantId,
        ),
    },
    apiKey: {
      select: `SELECT tenant_id FROM api_keys WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_test', 'key', 'passwords:read', now() + interval '1 day')`,
          randomUUID(), ids.userId, ids.tenantId, hex(32),
        ),
    },
    webAuthnCredential: {
      select: `SELECT tenant_id FROM webauthn_credentials WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO webauthn_credentials (id, user_id, tenant_id, credential_id, public_key, device_type)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pk', 'singleDevice')`,
          randomUUID(), ids.userId, ids.tenantId, hex(16),
        ),
    },
    extensionBridgeCode: {
      select: `SELECT tenant_id FROM extension_bridge_codes WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO extension_bridge_codes (id, code_hash, user_id, tenant_id, scope, expires_at, cnf_jkt)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'passwords:read', now() + interval '1 minute', $5)`,
          randomUUID(), hex(32), ids.userId, ids.tenantId, hex(16),
        ),
    },
    mobileBridgeCode: {
      select: `SELECT tenant_id FROM mobile_bridge_codes WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO mobile_bridge_codes (id, code_hash, user_id, tenant_id, state, code_challenge, device_jkt, expires_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, now() + interval '1 minute')`,
          randomUUID(), hex(32), ids.userId, ids.tenantId, hex(16), hex(16), hex(21),
        ),
    },
    mcpAccessToken: {
      select: revocable("mcp_access_tokens", "revoked_at"),
      seed: (sql, ids) =>
        sql(
          `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'credentials:list', now() + interval '1 hour')`,
          ids.mcpTokenId, hex(32), ids.mcpClientId, ids.tenantId, ids.userId,
        ),
    },
    mcpRefreshToken: {
      select: revocable("mcp_refresh_tokens", "revoked_at"),
      seed: (sql, ids) =>
        sql(
          `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, scope, expires_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'credentials:list', now() + interval '1 day')`,
          randomUUID(), hex(32), randomUUID(), ids.mcpTokenId, ids.mcpClientId, ids.tenantId, ids.userId,
        ),
    },
    delegationSession: {
      select: revocable("delegation_sessions", "revoked_at"),
      seed: (sql, ids) =>
        sql(
          `INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, ARRAY[$5]::text[], now() + interval '1 hour')`,
          randomUUID(), ids.tenantId, ids.userId, ids.mcpTokenId, ids.entryId,
        ),
    },
    mcpAuthorizationCode: {
      select: revocable("mcp_authorization_codes", "used_at"),
      seed: (sql, ids) =>
        sql(
          `INSERT INTO mcp_authorization_codes (id, code_hash, client_id, tenant_id, user_id, redirect_uri, scope, code_challenge, expires_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'http://127.0.0.1/callback', 'credentials:list', $6, now() + interval '1 minute')`,
          randomUUID(), hex(32), ids.mcpClientId, ids.tenantId, ids.userId, hex(32),
        ),
    },
  };

  /**
   * The migration's writes that are not counters (`NON_COUNTER_WRITES`), but
   * the membership, which `placement` reads with its active flag. The three
   * the migration moves by tenant alone are reached through their parent.
   */
  const NON_COUNTER_TABLES: Record<Exclude<NonCounterWriteHandle, "tenantMember">, OwnedTable> = {
    user: { select: `SELECT tenant_id FROM users WHERE id = $1::uuid`, seed: null },
    passwordEntryHistory: {
      select: `SELECT h.tenant_id FROM password_entry_histories h
                 JOIN password_entries e ON e.id = h.entry_id WHERE e.user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, key_version)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'blob', $4, $5, 1)`,
          randomUUID(), ids.entryId, ids.tenantId, IV, TAG,
        ),
    },
    emergencyAccessKeyPair: {
      select: `SELECT k.tenant_id FROM emergency_access_key_pairs k
                 JOIN emergency_access_grants g ON g.id = k.grant_id WHERE g.owner_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO emergency_access_key_pairs (id, grant_id, tenant_id, encrypted_private_key, private_key_iv, private_key_auth_tag)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'key', $4, $5)`,
          randomUUID(), ids.grantId, ids.tenantId, IV, TAG,
        ),
    },
    shareAccessLog: {
      select: `SELECT l.tenant_id FROM share_access_logs l
                 JOIN password_shares s ON s.id = l.share_id WHERE s.created_by_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO share_access_logs (id, share_id, tenant_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
          randomUUID(), ids.shareId, ids.tenantId,
        ),
    },
    auditLog: {
      select: `SELECT tenant_id FROM audit_logs WHERE user_id = $1::uuid`,
      seed: (sql, ids) =>
        sql(
          `INSERT INTO audit_logs (id, scope, action, user_id, tenant_id, actor_type, outbox_id, created_at)
           VALUES ($1::uuid, 'PERSONAL', 'AUTH_LOGIN', $2::uuid, $3::uuid, 'HUMAN', $4::uuid, now())`,
          randomUUID(), ids.userId, ids.tenantId, randomUUID(),
        ),
    },
  };

  const OWNED_TABLES = { ...COUNTER_TABLES, ...NON_COUNTER_TABLES };
  type OwnedHandle = keyof typeof OWNED_TABLES;

  /**
   * One row of `userId`'s in every table the migration writes but `users` /
   * `accounts` (seeded by `createUser` / `linkAccount`), filed under
   * `tenantId`, plus the MCP client the MCP rows hang off (tenant-owned).
   */
  async function seedOwnedRows(userId: string, tenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const ids: SeedIds = {
        userId,
        tenantId,
        entryId: randomUUID(),
        grantId: randomUUID(),
        shareId: randomUUID(),
        mcpClientId: randomUUID(),
        mcpTokenId: randomUUID(),
      };
      const sql: Sql = (text, ...values) => tx.$executeRawUnsafe(text, ...values);
      await sql(
        `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, '', $4, ARRAY['http://127.0.0.1/callback']::text[], 'credentials:list', now())`,
        ids.mcpClientId, tenantId, `mcpc_${hex(16)}`, `client-${hex(8)}`,
      );
      for (const table of Object.values(OWNED_TABLES)) {
        if (table.seed) await table.seed(sql, ids);
      }
    });
  }

  /** Per table the migration writes, the distinct tenants `userId`'s rows are filed under (sorted; empty when none). */
  async function movedTableTenants(userId: string): Promise<Record<OwnedHandle, string[]>> {
    const [row] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const columns = (Object.entries(OWNED_TABLES) as [OwnedHandle, OwnedTable][])
        .map(([handle, { select }]) =>
          `'${handle}', COALESCE((SELECT json_agg(DISTINCT t.tenant_id ORDER BY t.tenant_id) FROM (${select}) t), '[]'::json)`)
        .join(",\n");
      return tx.$queryRawUnsafe<{ rows: Record<OwnedHandle, string[]> }[]>(
        `SELECT json_build_object(${columns}) AS rows`,
        userId,
      );
    });
    return row!.rows;
  }

  /** The victim and a row of theirs in every table the bootstrap migration moves. */
  async function seedVictim(state: VictimState, accountProvider: string): Promise<Victim> {
    const home = await ctx.createTenant();
    if (state === VICTIM_STATE.BOOTSTRAP) {
      await ctx.su.prisma.$executeRaw`UPDATE tenants SET is_bootstrap = true WHERE id = ${home}::uuid`;
    }
    const userId = await ctx.createUser(home);
    await linkAccount(userId, home, accountProvider);
    await seedOwnedRows(userId, home);
    if (state === VICTIM_STATE.DEPARTED) await deactivateMemberships(userId);
    return { userId, email: await emailOf(userId), home };
  }

  /** Every row of the victim's a sign-in could move, as text so a change anywhere shows. */
  async function victimRows(userId: string): Promise<string> {
    const [row] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ rows: string }[]>(
        `SELECT json_build_object(
           'user', (SELECT json_build_object('tenant', tenant_id, 'email', email) FROM users WHERE id = $1::uuid),
           'members', (SELECT json_agg(json_build_object('tenant', tenant_id, 'active', deactivated_at IS NULL) ORDER BY tenant_id)
                         FROM tenant_members WHERE user_id = $1::uuid),
           'accounts', (SELECT json_agg(json_build_object('provider', provider, 'sub', provider_account_id, 'tenant', tenant_id)
                          ORDER BY provider, provider_account_id) FROM accounts WHERE user_id = $1::uuid)
         )::text AS rows`,
        userId,
      );
    });
    return `${row!.rows} ${JSON.stringify(await movedTableTenants(userId))}`;
  }

  async function activeMembers(tenantId: string): Promise<number> {
    return ctx.su.prisma.tenantMember.count({ where: { tenantId, deactivatedAt: null } });
  }

  async function notLinkedRows(userId: string): Promise<OutboxRow[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT tenant_id::text, payload->'metadata' AS metadata, row_to_json(o)::text AS row_text
           FROM audit_outbox o
          WHERE payload->>'action' = 'AUTH_LOGIN_FAILURE' AND payload->>'userId' = $1`,
        userId,
      );
    });
  }

  /** The attacker's tenant, with its claim bound to the attacker's own connection. */
  async function attackerTenant(mode: ClaimBindingMode): Promise<{ tenantId: string; claim: string }> {
    const tenantId = await ctx.createTenant();
    const claim = freshClaim(`s1-${mode}`);
    await bindClaim(tenantId, claim, SIGN_IN_PROVIDER);
    return { tenantId, claim };
  }

  /**
   * The victim's user row goes first: a row-4 join moves the column but leaves
   * their rows under the old tenant, where `deleteTestData`'s by-tenant user
   * delete no longer reaches them and their RESTRICT tenant FKs block the
   * tenant delete. Every moved table but audit_logs and the MCP tables
   * cascades from `users`; those, the MCP client and the outbox are swept by
   * tenant.
   */
  async function teardown(victim: Victim | null, ...tenants: string[]): Promise<void> {
    if (victim) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, victim.userId);
      });
    }
    for (const tenantId of tenants) await ctx.deleteTestData(tenantId);
  }

  /**
   * S1 — whose rows a sign-in writes. Auth.js calls the signIn callback BEFORE
   * its own account-link check and refuses an unlinked account whose email
   * names a user (`OAuthAccountNotLinked`) only afterwards, so a callback that
   * took the user by the asserted email committed membership writes for a
   * user Auth.js then refused to sign in. The attacker here administers the
   * IdP behind their own connection, has their own tenant's claim bound to it,
   * and asserts the victim's email.
   *
   * The victim states: a departed member (no active membership), whom row 4
   * would join to the attacker's tenant and realign — a write that commits —
   * and a bootstrap member, the finding's own case, whom row 6 would migrate
   * into the attacker's tenant with all their rows.
   */
  describe("S1: the sign-in subject is the user Auth.js signs in", () => {
    const DENY_GRID = [CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT].flatMap((mode) =>
      Object.values(VICTIM_STATE).map((state) => [mode, state] as const),
    );

    it.each(DENY_GRID)(
      "%s mode, %s: an unlinked account asserting the victim's email is refused before any write",
      async (mode, state) => {
        stubModeEnv(mode);
        const attacker = await attackerTenant(mode);
        let victim: Victim | null = null;
        try {
          victim = await seedVictim(state, OTHER_PROVIDER);
          const before = await victimRows(victim.userId);
          const attackerMembers = await activeMembers(attacker.tenantId);
          const subject = `attacker-${randomUUID()}`;

          const allowed = await capturedSignIn()(
            signInParams(victim.email, attacker.claim, SIGN_IN_PROVIDER, subject),
          );

          expect(allowed).toBe(false);
          expect(await victimRows(victim.userId)).toBe(before);
          expect(await activeMembers(attacker.tenantId)).toBe(attackerMembers);
          expect(await ctx.su.prisma.account.count({ where: { provider: SIGN_IN_PROVIDER, providerAccountId: subject } })).toBe(0);
          expect(await ctx.su.prisma.tenantClaimEvent.count({ where: { claim: attacker.claim } })).toBe(0);
          const rows = await notLinkedRows(victim.userId);
          expect(rows).toHaveLength(1);
          expect(rows[0]!.tenant_id).toBe(victim.home);
          expect(rows[0]!.metadata.reason).toBe("account_not_linked");
          expect(rows[0]!.metadata).not.toHaveProperty("claim");
        } finally {
          await teardown(victim, attacker.tenantId, ...(victim ? [victim.home] : []));
        }
      },
    );

    it.each(DENY_GRID)(
      "%s mode, %s: a linked account asserting the victim's email signs in its own user and writes nothing for the victim",
      async (mode, state) => {
        stubModeEnv(mode);
        const attacker = await attackerTenant(mode);
        let victim: Victim | null = null;
        try {
          victim = await seedVictim(state, OTHER_PROVIDER);
          const insider = await existingUser(attacker.tenantId);
          const before = await victimRows(victim.userId);

          // Auth.js hands the callback the linked user for a linked account;
          // the profile-shaped user is passed anyway, so the subject can only
          // have come from the account row.
          const allowed = await capturedSignIn()(
            signInParams(victim.email, attacker.claim, SIGN_IN_PROVIDER, insider.providerAccountId),
          );

          expect(allowed).toBe(true);
          expect(await victimRows(victim.userId)).toBe(before);
          expect(await tenantOf(insider.userId)).toBe(attacker.tenantId);
          expect(await notLinkedRows(victim.userId)).toHaveLength(0);
        } finally {
          await teardown(victim, attacker.tenantId, ...(victim ? [victim.home] : []));
        }
      },
    );

    it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
      "%s mode: the victim's own linked account resolves them as before (row 4 join)",
      async (mode) => {
        stubModeEnv(mode);
        const target = await attackerTenant(mode);
        let victim: Victim | null = null;
        try {
          victim = await seedVictim(VICTIM_STATE.DEPARTED, OTHER_PROVIDER);
          const own = await linkAccount(victim.userId, victim.home, SIGN_IN_PROVIDER);
          const before = await victimRows(victim.userId);

          expect(await capturedSignIn()(signInParams(victim.email, target.claim, SIGN_IN_PROVIDER, own))).toBe(true);
          // The positive control for the deny cells' unchanged snapshot: the
          // same snapshot sees this allowed sign-in's writes.
          expect(await victimRows(victim.userId)).not.toBe(before);
          expect(await tenantOf(victim.userId)).toBe(target.tenantId);
          expect(
            await ctx.su.prisma.tenantMember.count({
              where: { userId: victim.userId, tenantId: target.tenantId, deactivatedAt: null },
            }),
          ).toBe(1);
        } finally {
          await teardown(victim, ...(victim ? [victim.home] : []), target.tenantId);
        }
      },
    );

    it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
      "%s mode: the bootstrap victim's own linked account migrates them (row 6)",
      async (mode) => {
        stubModeEnv(mode);
        const target = await attackerTenant(mode);
        let victim: Victim | null = null;
        try {
          victim = await seedVictim(VICTIM_STATE.BOOTSTRAP, OTHER_PROVIDER);
          const own = await linkAccount(victim.userId, victim.home, SIGN_IN_PROVIDER);
          const before = await victimRows(victim.userId);

          expect(await capturedSignIn()(signInParams(victim.email, target.claim, SIGN_IN_PROVIDER, own))).toBe(true);
          // The positive control for the deny cells' unchanged snapshot: the
          // same snapshot sees this allowed sign-in's writes.
          expect(await victimRows(victim.userId)).not.toBe(before);
          expect(await tenantOf(victim.userId)).toBe(target.tenantId);
          expect(await ctx.su.prisma.tenantMember.findMany({
            where: { userId: victim.userId },
            select: { tenantId: true, deactivatedAt: true },
          })).toEqual([{ tenantId: target.tenantId, deactivatedAt: null }]);
        } finally {
          await teardown(victim, ...(victim ? [victim.home] : []), target.tenantId);
        }
      },
    );

    /**
     * Google with GOOGLE_WORKSPACE_DOMAINS set links by email, so an unlinked
     * Google account whose email names a user proceeds with that user. The
     * flag is read when auth.config.ts loads, hence the fresh module graph.
     */
    it("Google with email linking on: an unlinked account whose email names a user proceeds with that user", async () => {
      const domain = freshClaim("s1-google");
      stubClaimProviderEnv({ google: true });
      vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", domain);
      vi.resetModules();
      const loaded = nextAuthConfigs.length;
      await import("@/auth");
      const fresh = nextAuthConfigs[loaded] as { callbacks?: { signIn?: SignInCallback } } | undefined;
      const freshSignIn = fresh?.callbacks?.signIn;
      if (!freshSignIn) throw new Error("the fresh src/auth.ts did not hand NextAuth a signIn callback");
      const { allowsDangerousEmailAccountLinking } = await import("@/auth.config");
      expect(allowsDangerousEmailAccountLinking("google")).toBe(true);

      const target = await ctx.createTenant();
      await bindClaim(target, domain, "google");
      let victim: Victim | null = null;
      try {
        victim = await seedVictim(VICTIM_STATE.DEPARTED, OTHER_PROVIDER);
        const allowed = await freshSignIn({
          user: { id: "google-subject", email: victim.email },
          account: { provider: "google", type: "oidc", providerAccountId: `google-${randomUUID()}` },
          profile: { hd: domain },
        });

        expect(allowed).toBe(true);
        expect(await tenantOf(victim.userId)).toBe(target);
        expect(await notLinkedRows(victim.userId)).toHaveLength(0);
      } finally {
        await teardown(victim, ...(victim ? [victim.home] : []), target);
      }
    });
  });

  /**
   * Rows 6 / 9a: a bootstrap member signing in with a claim moves to the
   * claimed tenant — every row of theirs, and their one active membership.
   * The migration deletes the bootstrap membership before creating the new
   * one; the other order is refused by `tenant_members_one_active_per_user`,
   * which unit tests with a mocked Prisma cannot see.
   */
  describe("rows 6 / 9a: the bootstrap migration", () => {
    /** Where each of the member's rows is filed, per moved table, and their memberships. */
    async function placement(userId: string) {
      const members = await ctx.su.prisma.tenantMember.findMany({
        where: { userId },
        select: { tenantId: true, deactivatedAt: true },
      });
      return { tables: await movedTableTenants(userId), members };
    }

    /**
     * The placement after a migration from `home` to `tenantId`: every table
     * moved, but the MCP rows, which stay under `home`, revoked. Without `home`,
     * every row of every table under `tenantId`, live — the seeded state.
     */
    function movedTo(tenantId: string, home?: string) {
      const tables = Object.fromEntries(
        Object.keys(OWNED_TABLES).map((handle) => {
          const revoked =
            home !== undefined &&
            (MIGRATED_COUNTERS as Record<string, string>)[handle] === MIGRATION_TREATMENT.REVOKE;
          return [handle, [revoked ? `${home} revoked` : tenantId]];
        }),
      );
      return { tables, members: [{ tenantId, deactivatedAt: null }] };
    }

    /**
     * A user of a third tenant with a row in every moved table. The migration
     * moves `passwordEntryHistory`, `emergencyAccessKeyPair` and
     * `shareAccessLog` by tenant alone, so these rows show it does not reach
     * past the bootstrap tenant. `onTenant` receives the tenant before any row
     * is seeded, so a seed that throws still leaves it to the caller's teardown.
     */
    async function seedBoundary(onTenant: (tenantId: string) => void): Promise<{ tenantId: string; userId: string }> {
      const tenantId = await ctx.createTenant();
      onTenant(tenantId);
      const userId = await ctx.createUser(tenantId);
      await linkAccount(userId, tenantId);
      await seedOwnedRows(userId, tenantId);
      return { tenantId, userId };
    }

    /** Every moved table holds the member's rows before the sign-in, so "moved" cannot pass on an empty table. */
    async function expectSeededEverywhere(userId: string, tenantId: string): Promise<void> {
      expect((await placement(userId)).tables).toEqual(movedTo(tenantId).tables);
    }

    async function seedBootstrapMember(): Promise<Victim & { providerAccountId: string }> {
      const member = await seedVictim(VICTIM_STATE.BOOTSTRAP, OTHER_PROVIDER);
      return { ...member, providerAccountId: await linkAccount(member.userId, member.home, SIGN_IN_PROVIDER) };
    }

    async function claimedTenant(arm: string): Promise<{ tenantId: string; claim: string }> {
      const tenantId = await ctx.createTenant();
      const claim = freshClaim(arm);
      await bindClaim(tenantId, claim, SIGN_IN_PROVIDER);
      return { tenantId, claim };
    }

    it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
      "%s mode, row 9a: an unregistered claim creates its tenant and moves the member there",
      async (mode) => {
        stubModeEnv(mode);
        const claim = freshClaim(`migrate-9a-${mode}`);
        let member: (Victim & { providerAccountId: string }) | null = null;
        let created: string | null = null;
        let boundaryTenant: string | null = null;
        try {
          const boundary = await seedBoundary((id) => (boundaryTenant = id));
          member = await seedBootstrapMember();
          await expectSeededEverywhere(member.userId, member.home);

          expect(
            await capturedSignIn()(signInParams(member.email, claim, SIGN_IN_PROVIDER, member.providerAccountId)),
          ).toBe(true);

          const row = await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim } });
          created = row.tenantId;
          ctx.trackTenant(created);
          expect(row.provider).toBe(SIGN_IN_PROVIDER);
          expect(await placement(member.userId)).toEqual(movedTo(created, member.home));
          expect(await ctx.su.prisma.tenantMember.count({ where: { tenantId: member.home } })).toBe(0);
          expect(await placement(boundary.userId)).toEqual(movedTo(boundary.tenantId));
        } finally {
          await teardown(
            member,
            ...(member ? [member.home] : []),
            ...(created ? [created] : []),
            ...(boundaryTenant ? [boundaryTenant] : []),
          );
        }
      },
    );

    it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
      "%s mode, row 6: a registered claim moves the member into its tenant",
      async (mode) => {
        stubModeEnv(mode);
        const target = await claimedTenant(`migrate-6-${mode}`);
        let member: (Victim & { providerAccountId: string }) | null = null;
        let boundaryTenant: string | null = null;
        try {
          const boundary = await seedBoundary((id) => (boundaryTenant = id));
          member = await seedBootstrapMember();
          await expectSeededEverywhere(member.userId, member.home);

          expect(
            await capturedSignIn()(signInParams(member.email, target.claim, SIGN_IN_PROVIDER, member.providerAccountId)),
          ).toBe(true);

          expect(await placement(member.userId)).toEqual(movedTo(target.tenantId, member.home));
          expect(await ctx.su.prisma.tenantMember.count({ where: { tenantId: member.home } })).toBe(0);
          expect(await outboxRowsForClaim(target.claim)).toHaveLength(0);
          expect(await placement(boundary.userId)).toEqual(movedTo(boundary.tenantId));
        } finally {
          await teardown(member, ...(member ? [member.home] : []), target.tenantId, ...(boundaryTenant ? [boundaryTenant] : []));
        }
      },
    );

    /**
     * The target already holds a membership row for the member — deactivated,
     * since the bootstrap membership is the active one. Reactivating it is the
     * target tenant's decision, not a sign-in's, so the migration is refused
     * before any write and the member keeps their bootstrap tenant.
     */
    it("row 6, a deactivated membership row in the target: refused with tenant_mismatch, nothing written", async () => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const target = await claimedTenant("migrate-6-deactivated");
      let member: (Victim & { providerAccountId: string }) | null = null;
      try {
        member = await seedBootstrapMember();
        const { userId } = member;
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
            randomUUID(),
            target.tenantId,
            userId,
          );
        });
        const before = await victimRows(member.userId);

        expect(
          await capturedSignIn()(signInParams(member.email, target.claim, SIGN_IN_PROVIDER, member.providerAccountId)),
        ).toBe(false);

        expect(await victimRows(member.userId)).toBe(before);
        expect(await tenantOf(member.userId)).toBe(member.home);
        const rows = await outboxRowsForClaim(target.claim);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.tenant_id).toBe(target.tenantId);
        expect(rows[0]!.metadata.reason).toBe("tenant_mismatch");
      } finally {
        await teardown(member, ...(member ? [member.home] : []), target.tenantId);
      }
    });

    /** Row 6b: a bootstrap tenant with a second active member is not migrated. */
    it("row 6b, a second active member in the bootstrap tenant: refused, nothing written", async () => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const target = await claimedTenant("migrate-6b");
      let member: (Victim & { providerAccountId: string }) | null = null;
      try {
        member = await seedBootstrapMember();
        const second = await ctx.createUser(member.home);
        const before = await victimRows(member.userId);
        const targetMembers = await ctx.su.prisma.tenantMember.count({ where: { tenantId: target.tenantId } });

        expect(
          await capturedSignIn()(signInParams(member.email, target.claim, SIGN_IN_PROVIDER, member.providerAccountId)),
        ).toBe(false);

        expect(await victimRows(member.userId)).toBe(before);
        expect(await ctx.su.prisma.tenantMember.count({ where: { tenantId: target.tenantId } })).toBe(targetMembers);
        expect(await tenantOf(second)).toBe(member.home);
      } finally {
        await teardown(member, ...(member ? [member.home] : []), target.tenantId);
      }
    });
  });

  describe("off-mode mismatch warning", () => {
    function spyWarn() {
      const warn = vi.fn();
      const real = loggerModule.getLogger();
      vi.spyOn(loggerModule, "getLogger").mockReturnValue(
        new Proxy(real, {
          get: (target, key) => (key === "warn" ? warn : Reflect.get(target, key)),
        }),
      );
      return warn;
    }

    it.each([
      [ROW_STATE.BOUND_OTHER, true],
      [ROW_STATE.BOUND_SAME, false],
      [ROW_STATE.UNBOUND, false],
    ] as const)("a %s row: warned=%s", async (rowState, warned) => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const owner = await ctx.createTenant();
      const claim = freshClaim(`warn-${rowState}`);
      await bindClaim(owner, claim, ROW_PROVIDER[rowState]);
      const warn = spyWarn();
      try {
        expect(await firstSignIn(`bind-${randomUUID()}@example.invalid`, claim)).toBe(true);
        const calls = warn.mock.calls.filter(([, msg]) => msg === "auth.tenant_claim.provider_mismatch");
        if (!warned) {
          expect(calls).toHaveLength(0);
          return;
        }
        expect(calls).toHaveLength(1);
        // Provider ids and the tenant only — never the claim.
        expect(calls[0]![0]).toEqual({
          tenantId: owner,
          boundProvider: OTHER_PROVIDER,
          signInProvider: SIGN_IN_PROVIDER,
        });
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });

  describe("C5: the provider travels with the claim", () => {
    async function createUserUnder(store: { tenantClaim: string; provider: string | null }, metaProvider: string | null) {
      const meta: SessionMeta = { ip: null, userAgent: null, acceptLanguage: null, provider: metaProvider };
      const createUser = createCustomAdapter().createUser;
      if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
      const email = `bind-${randomUUID()}@example.invalid`;
      let caught: unknown = null;
      await sessionMetaStorage.run(meta, () =>
        tenantClaimStorage.run(store, async () => {
          try {
            await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          } catch (error) {
            caught = error;
          }
        }),
      );
      return { email, caught };
    }

    it.each([
      ["a claim with no provider", null, null],
      ["a session meta naming another provider", SIGN_IN_PROVIDER, OTHER_PROVIDER],
    ] as const)("refuses %s with provider_error and writes nothing", async (_label, storeProvider, metaProvider) => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const owner = await ctx.createTenant();
      const claim = freshClaim("c5");
      await bindClaim(owner, claim, SIGN_IN_PROVIDER);
      try {
        const before = await snapshot(claim, "", owner);
        const { email, caught } = await createUserUnder({ tenantClaim: claim, provider: storeProvider }, metaProvider);
        expect((caught as Error | null)?.message).toBe("TENANT_CLAIM_UNUSABLE");
        expect(await ctx.su.prisma.user.count({ where: { email } })).toBe(0);
        expect(await snapshot(claim, "", owner)).toEqual(before);
        const [row] = await outboxRowsForClaim(claim);
        expect(row?.metadata.reason).toBe("provider_error");
      } finally {
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
              WHERE payload->'metadata'->>'claim' = $1 AND status IN ('PENDING', 'PROCESSING')`,
            claim,
          );
          await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE payload->'metadata'->>'claim' = $1`, claim);
        });
        await ctx.deleteTestData(owner);
      }
    });

    it.each([
      ["agrees", SIGN_IN_PROVIDER],
      ["is absent", null],
    ] as const)("allows when the session meta %s", async (_label, metaProvider) => {
      stubModeEnv(CLAIM_BINDING_MODE.STRICT);
      const owner = await ctx.createTenant();
      const claim = freshClaim("c5-allow");
      await bindClaim(owner, claim, SIGN_IN_PROVIDER);
      try {
        const { email, caught } = await createUserUnder({ tenantClaim: claim, provider: SIGN_IN_PROVIDER }, metaProvider);
        expect(caught).toBeNull();
        const user = await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } });
        expect(user?.tenantId).toBe(owner);
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });

  describe("concurrent first registration through two providers", () => {
    let second: PrismaWithPool;

    beforeAll(() => {
      second = createPrismaForRole("app");
    });

    afterAll(async () => {
      await second.prisma.$disconnect().then(() => second.pool.end());
    });

    it("one tenant, one binding; the loser gets claim_provider_mismatch", async () => {
      const ITERATIONS = 50;
      // Settled rather than raced bare: a side that rejects would otherwise
      // drop the other side's committed tenant before it is tracked.
      const register =
        (provider: string, claim: string) =>
        (c: PrismaClient): Promise<PromiseSettledResult<ClaimTenantResolution>> =>
          withBypassRls(
            c,
            (tx) => findOrCreateTenantForClaim(claim, provider, CLAIM_BINDING_MODE.STRICT, tx),
            BYPASS_GRANT.AUTH_CREATE_USER,
          ).then(
            (value) => ({ status: "fulfilled", value }),
            (reason: unknown) => ({ status: "rejected", reason }),
          );
      const wins = { [SIGN_IN_PROVIDER]: 0, [OTHER_PROVIDER]: 0 };

      for (let i = 0; i < ITERATIONS; i++) {
        const claim = freshClaim(`race-${i}`);
        const created = new Set<string>();
        try {
          const settled = await raceTwoClients(
            ctx.app.prisma,
            second.prisma,
            register(SIGN_IN_PROVIDER, claim),
            register(OTHER_PROVIDER, claim),
          );
          for (const side of settled) {
            if (side.status === "fulfilled" && side.value.kind === "tenant") created.add(side.value.id);
          }
          const rejected = settled.find((side) => side.status === "rejected");
          if (rejected) {
            // The side that failed may still have committed before throwing.
            const rows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim }, select: { tenantId: true } });
            for (const row of rows) created.add(row.tenantId);
          }
          for (const id of created) ctx.trackTenant(id);
          if (rejected) throw rejected.reason;

          const [a, b] = settled.map((side) => (side as PromiseFulfilledResult<ClaimTenantResolution>).value);
          const winner = a.kind === "tenant" ? a : b.kind === "tenant" ? b : null;
          if (!winner || winner.kind !== "tenant") {
            throw new Error(`iteration ${i}: no registration won (${a.kind}, ${b.kind})`);
          }
          const loser = winner === a ? b : a;
          const winnerProvider = winner === a ? SIGN_IN_PROVIDER : OTHER_PROVIDER;
          wins[winnerProvider]++;
          expect(loser).toEqual({
            kind: "claim_provider_mismatch",
            tenantId: winner.id,
            boundProvider: winnerProvider,
          });
          const rows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ tenantId: winner.id, provider: winnerProvider });
          expect(await ctx.su.prisma.tenant.count({ where: { name: claim } })).toBe(1);
          expect(await ctx.su.prisma.tenantClaimEvent.count({ where: { claim } })).toBe(1);
        } finally {
          for (const id of created) await ctx.deleteTestData(id);
        }
      }

      // Both providers won at least once: a run in which one side always wins
      // is a serial run, and the end-state checks above hold for that too.
      expect(wins[SIGN_IN_PROVIDER]).toBeGreaterThan(0);
      expect(wins[OTHER_PROVIDER]).toBeGreaterThan(0);
    });
  });

  describe("schema", () => {
    it("passwd_app may INSERT the two provider columns of tenant_claim_events, and not seq", async () => {
      const [row] = await ctx.su.prisma.$queryRaw<{ old: boolean; new: boolean; seq: boolean }[]>`
        SELECT
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'old_provider', 'INSERT') AS old,
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'new_provider', 'INSERT') AS new,
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'seq', 'INSERT') AS seq
      `;
      expect(row).toEqual({ old: true, new: true, seq: false });
    });

    /**
     * One corpus through the TS predicate and through each live CHECK, by
     * attempting the write: the verdict is whatever PostgreSQL enforces, and
     * the constraint text is read back from pg_constraint to tie each verdict
     * to the pattern constant.
     */
    const LONGEST_GENERABLE = `saml-jackson-${"a".repeat(32)}`;
    const CORPUS: ReadonlyArray<readonly [string, string]> = [
      ["empty", ""],
      ["64 chars", "a".repeat(64)],
      ["65 chars", "a".repeat(65)],
      ["uppercase", "Saml-jackson"],
      ["underscore", "saml_jackson"],
      ["trailing newline", "saml-jackson\n"],
      ["non-ASCII", "saml-jackson-é"],
      ["longest generable id", LONGEST_GENERABLE],
      ["google", "google"],
    ];

    const CHECKS = [
      ["tenant_claims", "tenant_claims_provider_check", "provider"],
      ["tenant_claim_events", "tenant_claim_events_old_provider_check", "old_provider"],
      ["tenant_claim_events", "tenant_claim_events_new_provider_check", "new_provider"],
    ] as const;

    it.each(CHECKS)("%s.%s states PROVIDER_ID_PATTERN", async (table, constraint) => {
      const [row] = await ctx.su.prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         WHERE c.conname = ${constraint} AND c.conrelid = ${`public.${table}`}::regclass
      `;
      expect(row?.def).toContain(`'${PROVIDER_ID_PATTERN}'`);
    });

    it.each(CHECKS)("%s %s: the live CHECK agrees with isProviderIdShape on the corpus", async (table, _c, column) => {
      const tenantId = await ctx.createTenant();
      try {
        for (const [label, value] of CORPUS) {
          let accepted: boolean;
          try {
            await ctx.su.prisma.$transaction(async (tx) => {
              await setBypassRlsGucs(tx);
              if (table === "tenant_claims") {
                await tx.$executeRawUnsafe(
                  `INSERT INTO tenant_claims (id, tenant_id, claim, provider) VALUES ($1::uuid, $2::uuid, $3, $4)`,
                  randomUUID(),
                  tenantId,
                  freshClaim("parity"),
                  value,
                );
              } else {
                await tx.$executeRawUnsafe(
                  `INSERT INTO tenant_claim_events
                     (id, claim, operation, old_tenant_id, new_tenant_id, actor_label, ${column})
                   VALUES (gen_random_uuid(), $1, 'register', NULL, $2::uuid, 'binding-parity', $3)`,
                  freshClaim("parity"),
                  tenantId,
                  value,
                );
              }
              // Roll back every accepted write: the events table is
              // append-only, so nothing may commit.
              throw new RolledBack();
            });
            accepted = false;
          } catch (error) {
            accepted = error instanceof RolledBack;
          }
          expect(accepted, `${label} (${JSON.stringify(value)})`).toBe(isProviderIdShape(value));
        }
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });

    it("the deregister trigger copies the deleted row's provider", async () => {
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("deregister");
      await bindClaim(tenantId, claim, OTHER_PROVIDER);
      try {
        await ctx.su.prisma.tenantClaim.delete({ where: { claim } });
        const events = await ctx.su.prisma.tenantClaimEvent.findMany({
          where: { claim, operation: TENANT_CLAIM_EVENT_OPERATION.DEREGISTER },
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorLabel: DEREGISTER_ACTOR_LABEL,
          oldTenantId: tenantId,
          oldProvider: OTHER_PROVIDER,
          newProvider: null,
        });
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });
  });

  /**
   * The production derivation with a freshly loaded module graph, once per
   * mode — the proof that nothing below the env caches the mode. Strict here
   * is the FORCED arm: two claim providers and the variable unset.
   */
  describe("derived mode, fresh modules", () => {
    it.each([
      [CLAIM_BINDING_MODE.STRICT, false],
      [CLAIM_BINDING_MODE.OFF, true],
    ] as const)("%s: a NULL row through createUser is allowed=%s", async (mode, allowed) => {
      stubClaimProviderEnv(
        mode === CLAIM_BINDING_MODE.STRICT ? { google: true, connections: [SIGN_IN_PROVIDER] } : { google: true },
      );
      vi.resetModules();
      const { createCustomAdapter: freshAdapter } = await import("@/lib/auth/session/auth-adapter");
      const { tenantClaimStorage: freshStorage } = await import("@/lib/tenant/tenant-claim-storage");

      const owner = await ctx.createTenant();
      const claim = freshClaim(`derived-${mode}`);
      await bindClaim(owner, claim, null);
      const email = `bind-${randomUUID()}@example.invalid`;
      try {
        const createUser = freshAdapter().createUser;
        if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
        let caught: unknown = null;
        await freshStorage.run({ tenantClaim: claim, provider: "google" }, async () => {
          try {
            await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          } catch (error) {
            caught = error;
          }
        });
        expect(caught === null).toBe(allowed);
        if (!allowed) {
          const [row] = await outboxRowsForClaim(claim);
          expect(row?.metadata.reason).toBe("tenant_claim_unbound");
        }
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });
});

class RolledBack extends Error {}
