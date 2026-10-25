#!/usr/bin/env tsx
//
// Offline operator CLI for the SSO tenant claim registry (C7).
//
// Runs on MIGRATION_DATABASE_URL — a privileged (SUPERUSER-class) connection
// string, NOT the app's DATABASE_URL. `passwd_app` is NOSUPERUSER and every
// query it runs is RLS-bound; this tool needs neither a session nor an
// application token, only the database access an operator already has (NF1).
// That is also why there is no HTTP variant and no operator-bearer-token
// model involvement: an application-layer check here would guard a
// capability its holders can already exercise directly against the
// database.
//
// `tenant_claims` carries FORCE ROW LEVEL SECURITY (C1), which binds the
// table OWNER too — only a role with SUPERUSER or BYPASSRLS escapes it. Local
// Docker hides this because `passwd_user` is a real SUPERUSER; on RDS the
// master user holds `rds_superuser` but neither `rolsuper` nor
// `rolbypassrls`. Every command below therefore opens its own
// `withBypassRls` transaction before touching the table — skipping that
// would not error, it would silently return zero rows / zero matches
// ("list"/"unmapped" print nothing, an update reports "unknown domain")
// exactly at incident time.
//
// Module shape (round-3 M26): exported command functions that RETURN a
// result rather than call `process.exit`, so this file can be imported by
// the integration test without killing the vitest worker. A thin CLI
// wrapper (main(), guarded to run only when invoked directly — see the tail
// of this file) translates the result into `process.exitCode`. No
// module-scope client construction, no module-scope loadEnv() side effect
// beyond calling it once at import time: `MIGRATION_DATABASE_URL` itself is
// still read PER CALL inside each command, never memoised, so the "missing
// env var" case does not depend on call order against the other cases that
// need it set.
//
// Usage:
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- list [--tenant <ref>] [--unbound]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped [--days <n>]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add     --tenant <ref> --domain <domain> --by <label> (--provider <id> | --unbound) [--from <current-owner-uuid>] [--accept-unused-provider] [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- bind    --claim <claim> --provider <id> --by <label> [--accept-unused-provider] [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- bind    --from-members --out <file>
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- bind    --apply <file> --by <label> [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove  --tenant <ref> --domain <domain> --by <label> [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- history --domain <claim> | --tenant <uuid> [--after <seq>]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- realign --user <uuid|email> --tenant <ref> --by <label> [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- measure
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- legacy-accounts
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- backfill-owning-column --by <label> [--apply] [--yes] [--limit <n>]
//
// `measure` prints the three counts docs/archive/review/audit-tenant-adjudicator-design.md's
// "Measurements" section specifies — divergent column, multi-active-membership
// users, zero-active-membership users — read-only, no writes. `backfill-owning-column`
// lists the divergent population (the default, no writes) and, with --apply, moves
// each through the same adjudicator (`owningTenantOf`, `src/lib/tenant/owning-tenant-rule.ts`)
// `resolveOwningTenantIdFromClient` uses to answer reads, so this closes the WRITE
// side of the same class rather than introducing a second rule (C4/#838).
//
// `--tenant <ref>` accepts the tenant's UUID or one of its already-registered
// claims (normalised the same way `add`/`remove` normalise `--domain`).
// `tenants.slug` is NOT accepted — see resolveTenantRef for why (round-2 F-F).
//
// `--by` is a self-asserted operator label (NOT authenticated attribution —
// there is no application user identity on this connection, see SC8). It is
// stored verbatim in TenantClaim.createdBy only when a row is CREATED —
// deliberately not overwritten on the un-revoke or reassign paths, which
// preserve the original registrant, see cmdAdd — but that is `createdBy`
// specifically, not the flag. `--by` ALSO supplies `actor_label` on the
// `tenant_claim_events` row every one of the five verbs (register / revoke /
// unrevoke / reassign / rebind) appends in the same transaction (SC11 / #743), which
// is why `remove` requires it too, not just `add`. See `tenant-domain
// history` to read those rows back.
//
// `--from` is `add`'s reassignment flag: it names the tenant that currently
// owns the claim, and moves the claim off it. See cmdAdd for why it is a bare
// UUID and why it does not require a prior `remove`.
//
// `--provider` / `bind` (plan sso-claim-connection-binding, C3): every writer
// that sets a claim's provider binding runs one evidence check on the target
// tenant and records the binding on its event; `bind` changes an active row's
// binding and records a `rebind`. The SSO provider set and the binding mode
// come from the app env this process loaded — never the boot refusal, so these
// commands run in the window before AUTH_CLAIM_BINDING=strict is set.
//
// `history` also reports a `deregister` operation now: deleting a row from
// `tenant_claims` — directly, or by cascade from a tenant deletion — fires a
// trigger that appends one of these. `actor_label` is the fixed string
// `db-delete`, naming the mechanism rather than a person; who performed it is
// in `db_user`/`session_db_user`. `history` is capped at HISTORY_ROW_CAP rows
// per call; a capped result says to re-run the same command with
// `--after <seq>` appended — it does NOT rebuild the command line, because a
// claim is printable ASCII and would then be interpolated into something an
// operator is invited to paste into a shell. Ordered by the row's monotonic
// `seq`, not by `created_at` — the latter is millisecond-precision and cannot
// order two events written in the same millisecond.

import { loadEnv } from "@/lib/load-env";
loadEnv();

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { closeSync, fchmodSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { createPool, createPrismaClient, registerBypassNoticeSink, stderrBypassNoticeSink } from "@/lib/db/pool-factory";
import {
  normalizeTenantClaim,
  storableClaimSchema,
  operatorDomainSchema,
} from "@/lib/tenant/tenant-claim-registry";
import { UUID_RE, SYSTEM_TENANT_ID, SYSTEM_ACTOR_ID, NIL_UUID } from "@/lib/constants/app";
import {
  escapeUnsafeDisplayChars,
  UNSAFE_DISPLAY_CHARS_RE,
} from "@/lib/security/unsafe-display-chars";
import {
  ENGINE_WRITTEN_LABELS,
  recordTenantClaimEvent,
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
} from "@/lib/tenant/tenant-claim-event";
// The configured provider set, the derived binding mode and the adjudicator's
// strict predicate, from the same prisma-free modules the app reads (plan
// sso-claim-connection-binding, C2/C3). Never the boot refusal: `bind` and
// `list --unbound` exist for the window before strict is set.
import {
  CLAIM_BINDING_MODE,
  GOOGLE_PROVIDER_ID,
  JACKSON_CONNECTION_PROVIDER_ID_PREFIX,
  JACKSON_LEGACY_PROVIDER_ID,
  PROVIDER_ID_PATTERN,
  ProviderConfigError,
  deriveClaimBindingMode,
  isProviderIdShape,
  listClaimProviderIds,
  type ClaimBindingMode,
} from "@/lib/auth/jackson-providers";
import { deriveIdentifierPepper } from "@/lib/audit/identifier-pepper";
import { isUnusableUnderStrict } from "@/lib/tenant/claim-binding";
import { ACTOR_TYPE, AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
// `realign`'s I/O, from modules that never import the application's Prisma
// singleton: it throws at import without DATABASE_URL, and this tool runs on
// MIGRATION_DATABASE_URL alone (round-7 F-R7-2). `tenant-domain-import-graph.test.ts`
// fails when anything this file imports reaches it.
import { buildOutboxPayload } from "@/lib/audit/audit-payload";
import { enqueueAuditInTx } from "@/lib/audit/audit-outbox-in-tx";
import { countStrandedRows } from "@/lib/tenant/stranded-rows";
import { realignOwningTenantColumn } from "@/lib/tenant/owning-column";
import { REALIGNMENT_SOURCE, realignToMembershipInTxWith } from "@/lib/tenant/tenant-realignment-core";
// The SAME adjudicator `resolveOwningTenantIdFromClient` uses (C4/#838) — no
// Prisma import in this module (see its own header), so it is reachable here
// too. Imported directly, not through `tenant-context.ts`: that module's
// first line is `import { prisma } from "@/lib/prisma"`, which throws without
// DATABASE_URL, and `tenant-domain-import-graph.test.ts` fails the moment
// anything this file imports reaches it.
import { owningTenantOf } from "@/lib/tenant/owning-tenant-rule";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import { envInt } from "@/lib/env/env-utils";
import {
  asciiPrintable, AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { createPrompter } from "./lib/prompt";
import {
  parseFlags,
  getStringFlag,
  findValuelessFlag,
  valuelessError,
  findStrayFlags,
  strayFlagsError,
  type ParsedFlags,
} from "./lib/tenant-domain-flags";
import {
  bucketOf,
  UNMAPPED_BUCKET,
  UNMAPPED_SELECTED_REASONS,
  type UnmappedBucket,
} from "./lib/tenant-domain-buckets";
import {
  describeSignInProviderRef,
  evidenceOf,
  formatBindFile,
  formatEvidence,
  formatFlags,
  groupLegacyAccounts,
  isBindFileWritable,
  isInsideWorktree,
  isMajority,
  LEGACY_ACCOUNT_VERDICT,
  legacyAccountVerdict,
  parseBindFile,
  parseEvidence,
  refMappingFor,
  suggestedProvider,
  type BindFileRow,
  type BindRowFlags,
  type ClaimEvidence,
} from "./lib/tenant-domain-binding";

type TxClient = Prisma.TransactionClient;

export type CmdResult = {
  ok: boolean;
  code: number;
  message?: string;
  tenantId?: string;
  claim?: string;
  rows?: unknown[];
};

export type ConfirmFn = (message: string) => Promise<boolean>;

function missingUrlResult(): CmdResult {
  return {
    ok: false,
    code: 1,
    message:
      "MIGRATION_DATABASE_URL is required (a privileged connection string — " +
      "the app's DATABASE_URL role, passwd_app, is NOSUPERUSER and cannot " +
      "bypass tenant_claims' FORCE ROW LEVEL SECURITY).",
  };
}

// Never `src/lib/prisma.ts`'s singleton — it reads DATABASE_URL (the
// RLS-bound passwd_app role). Built fresh per command invocation, never at
// module scope, so the client's lifetime matches the command's.
//
// Exported as an object rather than a bare function so it is a real seam:
// C7's acceptance criterion for a missing MIGRATION_DATABASE_URL is "non-zero
// exit with an actionable message, and no database client built" — a property
// of the ORDER of two statements, which no assertion on the returned
// CmdResult can distinguish. The integration test spies on `.create` to prove
// it. Same motivation as the `confirm` seam below.
//
// Two client-side limits, because pg sets neither by default and `$disconnect()`
// in each command's `finally` waits on any connection still busy:
//   - connectionTimeoutMillis, read from DB_POOL_CONNECTION_TIMEOUT_MS with the app
//     pool's default and upper bound (src/lib/prisma.ts): a server that accepts the
//     connection and never answers hung the command after `maxWait` had already
//     failed it (round 9, F-R9-1; the variable, round 10 F-R10-4). 0, which pg
//     reads as no limit and the app accepts, falls back to the default here: the
//     lockout-recovery CLI must not hang (round 11, S-R11-2);
//   - query_timeout, the confirmation budget: a server that stops answering after
//     connecting left a query — Prisma's own timeout ROLLBACK included — waiting
//     with no limit (round 10, F-R10-5). No query outlasts its transaction anyway.
export const migrationClientFactory = {
  create(connectionString: string): PrismaClient {
    const pool = createPool({
      connectionString,
      connectionTimeoutMillis: envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5 * MS_PER_SECOND, { min: 1, max: MS_PER_MINUTE }),
      query_timeout: confirmationTransaction.options().timeout,
    });
    return createPrismaClient(pool, {}, { ownsPool: true });
  },
};

/**
 * The interactive-transaction budget for the commands that await an operator's
 * confirmation INSIDE their transaction (D-14): `add`, `remove`, `realign`.
 *
 * Prisma's own default is 5 s. Each of those prompts prints a warning meant to be
 * read, and an operator who read it for longer than that got a raw
 * "expired transaction" error with nothing written — which is how a confirmation
 * becomes `--yes` in practice (audit-tenant-adjudicator round 8, F-R8-2). Long
 * enough to read; short enough that a forgotten prompt does not hold a bypass
 * transaction open indefinitely. A seam, like `migrationClientFactory`, so a test
 * can shorten it and reach the timeout arm.
 */
export const confirmationTransaction = {
  options(): { timeout: number; maxWait: number } {
    return { timeout: 10 * MS_PER_MINUTE, maxWait: 10 * MS_PER_SECOND };
  },
};

/** The confirmation budget in the unit an operator reads it in. */
function confirmationBudgetText(): string {
  const { timeout } = confirmationTransaction.options();
  return timeout % MS_PER_MINUTE === 0 ? `${timeout / MS_PER_MINUTE} minutes` : `${timeout / MS_PER_SECOND} s`;
}

/**
 * The result for a confirmation that outlived its transaction, or null for any other error.
 *
 * Matched by Prisma's expiry message, not by P2028: that code covers its whole
 * transaction-error family, and a transaction that never started (`maxWait`,
 * an unreachable database) was reported as a slow operator, on every re-run
 * (audit-tenant-adjudicator round 9, F-R9-1).
 */
function confirmationTimeoutResult(error: unknown): CmdResult | null {
  if (!(error instanceof Error && /cannot be executed on an expired transaction/.test(error.message))) return null;
  return {
    ok: false,
    code: 1,
    message:
      `The confirmation took longer than this command's transaction allows (${confirmationBudgetText()}); nothing was written. ` +
      "Re-run the command: it reads the current state again before asking.",
  };
}

// `--tenant` resolution, in priority order:
//   1. a literal UUID names the tenant directly;
//   2. an already-registered claim (normalised the same way `--domain` is).
//
// `tenants.slug` is deliberately NOT a resolution path (round-2 F-F). A
// sign-in-created tenant gets `slug = slugifyTenant(rawClaim)`, which collapses
// `[^a-z0-9]+`, so the mapping from IdP claim to slug is many-to-one and the
// first tenant to take a slug keeps it: an attacker who can cause one tenant to
// be created — the same "one mistyped or squatted sign-in" cmdAdd's `--from`
// comment names — can pre-empt the slug an operator would later type (assert
// `"acme com"` to own `acme-com`). `--tenant` names the GAINING side of a
// reassignment, so a wrong resolution hands the claim to the attacker's tenant,
// and `--yes` removes the visual check. A registered claim carries no such
// hazard: `UNIQUE(claim)` makes the ref name at most one tenant, and the
// registration itself is recorded in `tenant_claim_events`.
//
// Revoked claims still resolve a tenant reference here — the row still
// occupies its slot in UNIQUE(claim) and identifying "which tenant used to
// own this" is a legitimate operator need (e.g. re-registering the same
// domain to the same tenant after a mistaken `remove`).
async function resolveTenantRef(
  tx: TxClient,
  ref: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const select = { id: true, name: true, slug: true } as const;

  if (UUID_RE.test(ref)) {
    return tx.tenant.findUnique({ where: { id: ref }, select });
  }

  const claim = normalizeTenantClaim(ref);
  const row = await tx.tenantClaim.findUnique({
    where: { claim },
    select: { tenantId: true },
  });
  if (!row) return null;
  return tx.tenant.findUnique({ where: { id: row.tenantId }, select });
}

async function activeMemberCount(tx: TxClient, tenantId: string): Promise<number> {
  return tx.tenantMember.count({ where: { tenantId, deactivatedAt: null } });
}

function printTenantSummary(
  tenant: { id: string; name: string; slug: string },
  activeMembers: number,
  label = "Tenant:",
): void {
  // `Tenant.name` is the raw claim for a sign-in-created tenant and the user's
  // email for a bootstrap one — neither CHECK-constrained, and rows predating
  // this PR's ingest boundary can carry anything the old stripping sanitizer
  // let through. Escaped for display (round-3 A3); `id` and `slug` are
  // structurally constrained and left alone.
  console.log(label);
  console.log(`  id:             ${tenant.id}`);
  console.log(`  name:           ${escapeUnsafeDisplayChars(tenant.name)}`);
  console.log(`  slug:           ${tenant.slug}`);
  console.log(`  active members: ${activeMembers}`);
}

// TTY confirmation, the default `confirm` seam. Tests inject their own
// `confirm` callback (or pass `--yes`/`yes: true`) so nothing here ever
// blocks on stdin in CI.
async function defaultConfirm(message: string): Promise<boolean> {
  const prompter = createPrompter({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  try {
    return await prompter.askYesNo(message, false);
  } finally {
    prompter.close();
  }
}

// ─── shared: the app env and the binding evidence ───────────────

/**
 * What this process knows of the deployment's SSO configuration (plan
 * sso-claim-connection-binding, C3): the claim-presenting provider ids and the
 * derived binding mode, read from the env `loadEnv()` loaded — the app's own
 * `.env` when the tool runs where the app does.
 *
 * "The app env is present" means at least one claim provider is configured.
 * Without one there is nothing to bind to: `--provider` falls back to the
 * provider-id pattern with a warning, and the commands that bind many rows at
 * once refuse. Read per call, never memoised, like MIGRATION_DATABASE_URL.
 */
type AppEnv = {
  readonly present: boolean;
  readonly claimProviders: readonly string[];
  readonly mode: ClaimBindingMode;
};

function readAppEnv(): { ok: true; env: AppEnv } | { ok: false; result: CmdResult } {
  try {
    const claimProviders = listClaimProviderIds(process.env);
    return {
      ok: true,
      env: { present: claimProviders.length > 0, claimProviders, mode: deriveClaimBindingMode(process.env) },
    };
  } catch (e) {
    // ProviderConfigError messages name the variable, never a value.
    if (!(e instanceof ProviderConfigError)) throw e;
    return {
      ok: false,
      result: {
        ok: false,
        code: 1,
        message: `The SSO provider configuration in this process's env is refused (${e.message}); fix it before binding claims.`,
      },
    };
  }
}

function appEnvRequiredResult(command: string): CmdResult {
  return {
    ok: false,
    code: 1,
    message:
      `${command} needs the app's environment: it binds claims to the configured SSO providers ` +
      "(AUTH_GOOGLE_*, AUTH_JACKSON_ID/SECRET, AUTH_JACKSON_CONNECTIONS, JACKSON_URL), and none is configured " +
      "in this process. Run it with the app's .env loaded.",
  };
}

/**
 * `--provider` against the configured set when the app env is present;
 * without it against the provider-id pattern only, with a warning that says so.
 */
function validateProviderFlag(provider: string, appEnv: AppEnv): CmdResult | null {
  if (appEnv.present) {
    if (appEnv.claimProviders.includes(provider)) return null;
    return {
      ok: false,
      code: 1,
      message:
        `--provider "${escapeUnsafeDisplayChars(provider)}" is not a configured claim provider. ` +
        `Configured: ${appEnv.claimProviders.join(", ")}.`,
    };
  }
  if (!isProviderIdShape(provider)) {
    return {
      ok: false,
      code: 1,
      message: `--provider "${escapeUnsafeDisplayChars(provider)}" is not a provider id (${PROVIDER_ID_PATTERN}).`,
    };
  }
  console.warn(
    `Warning: no SSO provider is configured in this process, so --provider "${escapeUnsafeDisplayChars(provider)}" ` +
      "was checked against the provider-id pattern only, not against the deployment's providers. A typo binds " +
      "the claim to a provider no sign-in presents.",
  );
  return null;
}

/** A Google or Jackson provider id by shape — the claim providers this tool can recognise without the app env. */
function isClaimProviderShapedId(id: string): boolean {
  return (
    id === GOOGLE_PROVIDER_ID ||
    id === JACKSON_LEGACY_PROVIDER_ID ||
    id.startsWith(JACKSON_CONNECTION_PROVIDER_ID_PREFIX)
  );
}

/**
 * The member evidence for one tenant: per claim provider, how many of its
 * ACTIVE members hold an account there, against the total. The providers
 * counted are the configured set; without the app env, every Google- or
 * Jackson-shaped provider the members hold accounts at, plus `extra` (the
 * provider being bound).
 */
async function readMemberEvidence(
  tx: TxClient,
  tenantId: string,
  appEnv: AppEnv,
  extra: string | null,
): Promise<ClaimEvidence> {
  const members = await tx.tenantMember.findMany({
    where: { tenantId, deactivatedAt: null },
    select: { userId: true },
  });
  const accounts =
    members.length === 0
      ? []
      : await tx.account.findMany({
          where: { userId: { in: members.map((m) => m.userId) } },
          select: { userId: true, provider: true },
        });
  const providersByUser = new Map<string, string[]>();
  for (const account of accounts) {
    const list = providersByUser.get(account.userId) ?? [];
    list.push(account.provider);
    providersByUser.set(account.userId, list);
  }
  const universe = new Set<string>(
    appEnv.present ? appEnv.claimProviders : accounts.map((a) => a.provider).filter(isClaimProviderShapedId),
  );
  if (extra !== null) universe.add(extra);
  return evidenceOf(
    members.map((m) => ({ userId: m.userId, providers: providersByUser.get(m.userId) ?? [] })),
    universe,
  );
}

/**
 * Where the claim came from, for the operator: who created the row, whether the
 * claim is the tenant's own id (the backfilled `external_id = id` shape), any
 * operator reassign/unrevoke, and the provider its last `register` event
 * recorded (null — "unknown" — for a pre-change event or none). Evidence, not
 * an attestation: the history predates provenance.
 */
async function readProvenance(
  tx: TxClient,
  claim: string,
  tenantId: string,
  createdBy: string | null,
): Promise<BindRowFlags> {
  const events = await tx.tenantClaimEvent.findMany({
    where: { claim },
    orderBy: { seq: "asc" },
    select: { operation: true, newProvider: true },
  });
  const operatorOps: readonly string[] = [TENANT_CLAIM_EVENT_OPERATION.REASSIGN, TENANT_CLAIM_EVENT_OPERATION.UNREVOKE];
  const registers = events.filter((e) => e.operation === TENANT_CLAIM_EVENT_OPERATION.REGISTER);
  return {
    createdBy,
    uuidClaim: claim === tenantId,
    operatorEvents: events.filter((e) => operatorOps.includes(e.operation)).map((e) => e.operation),
    registerProvider: registers.length === 0 ? null : registers[registers.length - 1].newProvider,
  };
}

function printEvidence(tenantId: string, evidence: ClaimEvidence, flags: BindRowFlags | null): void {
  console.log(`Binding evidence for tenant ${tenantId} (active members holding an account at each claim provider):`);
  console.log(`  members:    ${formatEvidence(evidence)}`);
  if (flags !== null) console.log(`  provenance: ${formatFlags(flags)}`);
  console.log(
    "  This is evidence for you to weigh, not an attestation: the claim's history predates provenance, " +
      "so no field above decides a binding on its own.",
  );
}

/**
 * The majority rule every provider-setting writer applies: members holding an
 * account at `provider` must be MORE than half of the tenant's active members,
 * unless the operator overrides it. A tenant with no active members has no
 * evidence either way and proceeds — normal onboarding before anyone signs in.
 */
function majorityRefusal(evidence: ClaimEvidence, provider: string, acceptUnused: boolean): CmdResult | null {
  if (evidence.total === 0) {
    console.log("  No evidence: the tenant has no active members yet, so nothing contradicts this binding.");
    return null;
  }
  const using = evidence.counts.get(provider) ?? 0;
  if (isMajority(using, evidence.total)) return null;
  const shortfall =
    `only ${using} of the tenant's ${evidence.total} active member(s) hold an account at ` +
    `"${escapeUnsafeDisplayChars(provider)}" — not a majority`;
  if (acceptUnused) {
    console.log(`  --accept-unused-provider: proceeding although ${shortfall}.`);
    return null;
  }
  return {
    ok: false,
    code: 1,
    message:
      `Refusing: ${shortfall}. Check that this is the connection this tenant's IdP sits behind ` +
      "(a claim bound to another customer's connection lets that IdP sign in as this tenant). " +
      "Re-run with --accept-unused-provider to bind it anyway.",
  };
}

// ─── list ────────────────────────────────────────────────────────

export async function cmdList(args: { tenant?: string; unbound?: boolean }): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  if (args.unbound === true) return listUnbound(url, args.tenant);

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        let tenantId: string | undefined;
        if (args.tenant) {
          const tenant = await resolveTenantRef(tx, args.tenant);
          if (!tenant) {
            return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(args.tenant)}` };
          }
          tenantId = tenant.id;
        }

        const rows = await tx.tenantClaim.findMany({
          where: tenantId ? { tenantId } : undefined,
          select: { claim: true, tenantId: true, createdBy: true, createdAt: true, revokedAt: true, provider: true },
          orderBy: { claim: "asc" },
        });

        // Rendered through the shared display escape, not printed verbatim
        // (round-3 A3). A row this PR wrote cannot carry a bidi or zero-width
        // character — the C1 CHECK restricts the stored form to printable
        // ASCII and the ingest boundary refuses the rest — but this table
        // predates neither constraint's enforcement on rows written by other
        // means, and `createdBy` is an operator-supplied free-text label that
        // no CHECK constrains at all. The escape costs nothing on a clean
        // value (byte-identical) and is the difference between reading a row
        // and being spoofed by one. There is still no punycode/IDN
        // canonicalisation in this PR (C2), so nothing else is rendered.
        for (const row of rows) {
          const status = row.revokedAt ? `revoked ${row.revokedAt.toISOString()}` : "active";
          const createdBy = row.createdBy === null ? "-" : escapeUnsafeDisplayChars(row.createdBy);
          // `provider` is CHECK-constrained to PROVIDER_ID_PATTERN; escaped anyway,
          // one rendering convention per column.
          const provider = row.provider === null ? "-" : escapeUnsafeDisplayChars(row.provider);
          console.log(
            `${escapeUnsafeDisplayChars(row.claim)}\ttenant=${row.tenantId}\tprovider=${provider}\tcreatedBy=${createdBy}\tcreatedAt=${row.createdAt.toISOString()}\t${status}`,
          );
        }

        const message =
          rows.length === 0
            ? tenantId
              ? `No claims registered for tenant ${tenantId}.`
              : "No claims registered."
            : `${rows.length} claim(s) listed.`;

        return { ok: true, code: 0, rows, message };
      },
      BYPASS_GRANT.TENANT_CLAIM_LIST,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * `list --unbound`: the active rows strict mode refuses for every configured
 * claim provider — unbound, or bound to a provider no longer configured —
 * decided by the adjudicator's own predicate (`isUnusableUnderStrict`), with a
 * suggested provider when the tenant's active members all use exactly one.
 *
 * Without the app env there is no configured set to judge a bound row
 * against, so only NULL rows are listed and the message says the rest were not
 * evaluated, rather than reading as "every bound row is fine".
 */
async function listUnbound(url: string, tenantRef: string | undefined): Promise<CmdResult> {
  const app = readAppEnv();
  if (!app.ok) return app.result;
  const appEnv = app.env;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        let tenantId: string | undefined;
        if (tenantRef) {
          const tenant = await resolveTenantRef(tx, tenantRef);
          if (!tenant) {
            return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(tenantRef)}` };
          }
          tenantId = tenant.id;
        }

        const candidates = await tx.tenantClaim.findMany({
          where: {
            revokedAt: null,
            ...(tenantId ? { tenantId } : {}),
            ...(appEnv.present ? {} : { provider: null }),
          },
          select: { claim: true, tenantId: true, createdBy: true, revokedAt: true, provider: true },
          orderBy: { claim: "asc" },
        });
        const rows = appEnv.present
          ? candidates.filter((row) => isUnusableUnderStrict(row, appEnv.claimProviders))
          : candidates;

        for (const row of rows) {
          const evidence = await readMemberEvidence(tx, row.tenantId, appEnv, null);
          const suggestion = suggestedProvider(evidence);
          const provider = row.provider === null ? "-" : escapeUnsafeDisplayChars(row.provider);
          console.log(
            `${escapeUnsafeDisplayChars(row.claim)}\ttenant=${row.tenantId}\tprovider=${provider}` +
              `\tmembers=${formatEvidence(evidence)}\tsuggest=${suggestion ?? "-"}`,
          );
        }

        const scope = appEnv.present
          ? `strict mode (claim providers: ${appEnv.claimProviders.join(", ")}) refuses at sign-in`
          : "carry no provider. No SSO provider is configured in this process, so rows bound to a provider " +
            "the deployment no longer configures were NOT evaluated; run this with the app's env to see them too";
        return {
          ok: true,
          code: 0,
          rows,
          message: `${rows.length} active claim(s) that ${scope}.`,
        };
      },
      BYPASS_GRANT.TENANT_CLAIM_BINDING_READ,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── unmapped ────────────────────────────────────────────────────

type UnmappedRow = {
  tenant_id: string;
  /** The value the IdP asserted. NULL on a refused-at-ingest denial. */
  claim: string | null;
  /**
   * Why this deployment refused the asserted value, or NULL when it did not
   * refuse one. Machine-generated and printable ASCII.
   *
   * TWO producers, not one (round-6 F1): the ingest boundary
   * (`extractTenantClaimValue`) and `storableClaimSchema`. Round 5 shipped only
   * the first, so the `unstorable`/`claim_invalid` population — a claim that
   * passes ingest but cannot be STORED, which is SC9's printable-ASCII
   * narrowing — arrived with `reason = tenant_mismatch`, a claim, and no
   * diagnosis. That is byte-identical to a row-7 "registered to a different
   * tenant" denial, so it bucketed as `other_tenant` and the report told the
   * operator to move the claim with `add --from` — for a claim registered
   * nowhere, using a command that refuses it on the same predicate.
   *
   * This field is the bucket discriminator (round-5 S2/S3). Round 4 bucketed
   * on `reason`, but `tenant_mismatch` has two producers — the ingest refusal
   * and row 7, "the claim is registered to a DIFFERENT tenant" — so a genuine
   * cross-tenant mismatch was printed under "the remedy is at the IdP", the
   * opposite of the README's own instruction for it. Round 4's first attempt
   * at a discriminator was a `refused: ` prefix inside `claim`, which an actor
   * who controls the asserted attribute can assert verbatim; a separate column
   * cannot be forged from the value side.
   */
  claim_refusal: string | null;
  cnt: bigint | number;
  last_seen: Date;
  // How many of `cnt` are denials that will NOT reach audit_logs without
  // operator action: FAILED (delivery exhausted its attempts), or PROCESSING
  // past the worker's own claim lease (a worker that crashed mid-delivery).
  //
  // PROCESSING *within* the lease is deliberately excluded (round-3 M5). It is
  // the normal in-flight state — a worker is delivering that row right now —
  // and counting it made a healthy queue read as degraded, which is worse than
  // silence: the message tells an operator their audit delivery is broken at
  // the moment they are diagnosing a lockout. The staleness boundary is
  // AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS, the worker's own reap threshold —
  // read from THIS process's environment, so the message names the value it
  // applied (round-4 F6).
  undelivered_cnt: bigint | number;
  /** `tenant_claim_unmapped` or `tenant_mismatch`. */
  reason: string;
  /**
   * A provider-binding denial's row binding (`boundProvider`): the owning
   * tenant's own provider, NULL for an unbound row and for every other reason.
   */
  bound_provider: string | null;
  /**
   * The presenting provider as the app stored it: a ref under the identifier
   * pepper, never the id (C4). NULL when the app had no pepper, and for every
   * other reason. Mapped back against this process's configured set.
   */
  sign_in_provider_ref: string | null;
};

// `AUDIT_LOG_RETENTION_MIN` is the configurable retention FLOOR, not any
// deployment's actual retention, so it can only ever be the default window —
// never a claim about what is retained. A deployment retaining a year of
// audit logs still has its older denials excluded here; `--days` is how an
// operator widens the query to them, and every message names the window it
// actually queried rather than calling it "the retained window" (Func F4).
export const DEFAULT_UNMAPPED_WINDOW_DAYS = AUDIT_LOG_RETENTION_MIN;
const MAX_UNMAPPED_WINDOW_DAYS = 3650;

// The worker's own "this claim is abandoned" threshold, reused rather than
// re-chosen (round-3 M5): reapStuckRows resets PROCESSING rows older than
// AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS, so a row younger than that is one the
// worker still considers its own.
//
// It is the same CONSTANT, not necessarily the same VALUE (round-4 F6, which
// corrected an overstatement here). `AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS` is
// `envInt("OUTBOX_PROCESSING_TIMEOUT_MS", …)`, resolved from THIS process's
// environment — and the documented way to run this tool is from a workstation
// against a remote deployment, which will not have that deployment's value.
// The rounding differs from the reaper's too. So the report prints the lease
// it applied (see cmdUnmapped's message) rather than claiming agreement it
// cannot guarantee.
const PROCESSING_LEASE_SECONDS = Math.ceil(
  AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / MS_PER_SECOND,
);

// Pure — exported so a test can pin the S12 "empty is not the same as
// silent" wording without depending on the shared dev DB happening to have
// zero real tenant_claim_unmapped denials at test time (other working
// copies on this same feature branch may be exercising sign-in concurrently).
export function formatUnmappedMessage(rows: UnmappedRow[], days: number): string {
  if (rows.length === 0) {
    // Names every class the query covers, not just the first (round-5 F6):
    // an operator using this to rule out the README's third cause would
    // otherwise get a message that never mentions it.
    return (
      `No claim-bearing sign-in denials — unregistered, other-tenant, refused or provider-binding — in the ` +
      `last ${days} days. That is the window this query covered, NOT this deployment's ` +
      `retention: a denial older than ${days} days is outside it whether or not the row ` +
      "still exists. Re-run with --days <n> to widen. An empty result does NOT by itself " +
      "mean nothing was denied."
    );
  }
  const undelivered = rows.reduce((sum, r) => sum + Number(r.undelivered_cnt), 0);
  const count = (bucket: UnmappedBucket) => rows.filter((r) => bucketOf(r) === bucket).length;
  // All three counts, always — a report that names only the registrable
  // population reads as "nothing else is wrong" (round-4 F3), and a report
  // that merges the other two sends the operator to the wrong remedy for one
  // of them (round-5 F1/S3).
  const base =
    `${count(UNMAPPED_BUCKET.UNREGISTERED)} unmapped-claim, ` +
    `${count(UNMAPPED_BUCKET.OTHER_TENANT)} other-tenant, ` +
    `${count(UNMAPPED_BUCKET.REFUSED)} refused-claim and ` +
    `${count(UNMAPPED_BUCKET.PROVIDER_BINDING)} provider-binding denial group(s) in the last ${days} days.`;
  if (undelivered === 0) return base;
  // Round-2 F-B: the operator must see that outbox delivery itself is degraded,
  // because these rows are the ones that would have been INVISIBLE while the
  // union looked only at PENDING — a report that under-reports precisely in the
  // stopped/crashed-worker case the union exists to cover.
  return (
    `${base} ${undelivered} of the denial event(s) are stranded in audit_outbox (FAILED, or ` +
    `PROCESSING with no progress for ${PROCESSING_LEASE_SECONDS}s): the outbox worker's delivery ` +
    "is degraded, so those events will not reach audit_logs without operator action. " +
    // Round-4 F6: the lease is read from THIS process's environment, so an
    // operator running the tool from a workstation against a remote
    // deployment may be applying a different threshold than that
    // deployment's worker. Naming it is what lets them notice.
    `(Lease read from this process's OUTBOX_PROCESSING_TIMEOUT_MS.)`
  );
}

export async function cmdUnmapped(args: { days?: number } = {}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const days = args.days ?? DEFAULT_UNMAPPED_WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_UNMAPPED_WINDOW_DAYS) {
    return {
      ok: false,
      code: 1,
      // operator-echo-exempt: `days` is a number here, not operator text — the
      // string form is refused earlier, in main()'s /^\d+$/ arm, which IS escaped.
      message: `Invalid --days "${days}": expected an integer between 1 and ${MAX_UNMAPPED_WINDOW_DAYS}.`,
    };
  }

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        // `audit_logs` is written only by the outbox worker, and a stopped
        // worker is a supported state (round-2 N14) — querying only
        // audit_logs would return a false-empty at exactly the moment an
        // operator needs this report. Two DIFFERENT JSON paths, not one:
        // audit_logs.metadata is a plain Json column, audit_outbox.payload
        // wraps the same shape one level deeper under `metadata`.
        //
        // Every NON-SENT outbox status, not just PENDING (round-2 F-B).
        // AuditOutboxStatus has four members: PENDING, PROCESSING, SENT,
        // FAILED. SENT is the only one whose event is already in audit_logs,
        // so it is the only one that must be excluded here — including it
        // would double-count. PROCESSING and FAILED are in neither audit_logs
        // nor PENDING, so the previous predicate under-reported exactly in the
        // degraded-worker case the union exists for.
        //
        // `undelivered` is a narrower question than "is this row in the
        // outbox": it asks whether the event is STRANDED. A PROCESSING row
        // inside the worker's claim lease is in flight, not stranded
        // (round-3 M5) — the lease boundary is the worker's own reaper
        // threshold, passed as $2 seconds. A PROCESSING row with a NULL
        // processing_started_at is counted as stranded: the comparison is
        // NULL, so it falls through to 1, which is the safe direction for a
        // row whose lease start is unknown.
        // BOTH claim-bearing denial reasons, bucketed by `reason` rather than
        // filtered down to one (round-4 F3). `tenant_claim_unmapped` is the
        // register-this-claim population; `tenant_mismatch` WITH a claim is
        // the refused-at-ingest population, whose remedy is at the IdP. The
        // command used to select only the first, so an IdP that started
        // emitting a zero-width character denied every sign-in in the
        // deployment while this report printed "no unmapped-claim denials".
        const rows = await tx.$queryRawUnsafe<UnmappedRow[]>(
          `SELECT tenant_id::text AS tenant_id, claim, claim_refusal, reason,
                  bound_provider, sign_in_provider_ref,
                  count(*)::int AS cnt, max(created_at) AS last_seen,
                  sum(undelivered)::int AS undelivered_cnt
             FROM (
               SELECT tenant_id, metadata->>'claim' AS claim,
                      metadata->>'claimRefusal' AS claim_refusal,
                      metadata->>'reason' AS reason,
                      metadata->>'boundProvider' AS bound_provider,
                      metadata->>'signInProviderRef' AS sign_in_provider_ref,
                      created_at, 0 AS undelivered
                 FROM audit_logs
                WHERE action = 'AUTH_LOGIN_FAILURE'::"AuditAction"
                  AND metadata->>'reason' = ANY($3::text[])
                  AND created_at >= now() - make_interval(days => $1::int)
               UNION ALL
               SELECT tenant_id, payload->'metadata'->>'claim' AS claim,
                      payload->'metadata'->>'claimRefusal' AS claim_refusal,
                      payload->'metadata'->>'reason' AS reason,
                      payload->'metadata'->>'boundProvider' AS bound_provider,
                      payload->'metadata'->>'signInProviderRef' AS sign_in_provider_ref,
                      created_at,
                      CASE
                        WHEN status = 'PENDING'::"AuditOutboxStatus" THEN 0
                        WHEN status = 'PROCESSING'::"AuditOutboxStatus"
                             AND processing_started_at > now() - make_interval(secs => $2::int) THEN 0
                        ELSE 1
                      END AS undelivered
                 FROM audit_outbox
                WHERE status <> 'SENT'::"AuditOutboxStatus"
                  AND payload->>'action' = 'AUTH_LOGIN_FAILURE'
                  AND payload->'metadata'->>'reason' = ANY($3::text[])
                  AND created_at >= now() - make_interval(days => $1::int)
             ) combined
            -- Either column identifies a reportable denial. Filtering on the
            -- claim alone would drop every refused-at-ingest row, since those
            -- now carry no claim at all (round-5 S2) -- the exact population
            -- round-4 F3 widened this query to catch.
            WHERE claim IS NOT NULL OR claim_refusal IS NOT NULL
            GROUP BY tenant_id, claim, claim_refusal, reason, bound_provider, sign_in_provider_ref
            ORDER BY last_seen DESC`,
          days,
          PROCESSING_LEASE_SECONDS,
          // ONE source for the reason set, bound as a parameter rather than
          // spelled in each UNION arm (round-6 T2). Round-4 F3 was a reason
          // missing from an inline predicate, and round 5's red-proof of the
          // fix covered only the audit_logs arm precisely because the two
          // copies could disagree.
          [...UNMAPPED_SELECTED_REASONS],
        );

        // Round-3 A3, and here it is not merely defensive: `claim` comes out
        // of audit_logs.metadata / audit_outbox.payload, neither of which is
        // CHECK-constrained, and rows written before this PR's ingest boundary
        // landed can still carry U+202E. This is the report an operator reads
        // while deciding which claim to register, so a value that renders as
        // something other than what it is would be acted on.
        // The configured set's refs under this process's pepper — the same
        // derivation the app stores them with, from the app env loadEnv() read.
        const app = readAppEnv();
        if (!app.ok && app.result.message) console.warn(`Warning: ${app.result.message}`);
        const refMapping = refMappingFor(
          app.ok ? app.env.claimProviders : [],
          deriveIdentifierPepper(process.env),
        );
        const printGroup = (heading: string, bucket: UnmappedBucket) => {
          const group = rows.filter((r) => bucketOf(r) === bucket);
          if (group.length === 0) return;
          console.log(heading);
          for (const row of group) {
            const undelivered = Number(row.undelivered_cnt);
            // Whichever fields the row HAS, rather than one or the other
            // (round-6 F1). An ingest refusal carries no claim by construction
            // (round-5 S2) but an UNSTORABLE claim carries both — the value the
            // IdP asserted and the rule it broke — and the operator needs the
            // value to know which tenant is affected. Printing only the
            // diagnosis for those rows would drop the one field that names the
            // population.
            //
            // Both are escaped: `claim` because pre-existing rows are not
            // CHECK-constrained, `claim_refusal` for one rendering convention
            // per terminal rather than an exception for values we believe we
            // generated (round-5 S5).
            const parts: string[] = [];
            if (row.claim !== null) parts.push(`claim="${escapeUnsafeDisplayChars(row.claim)}"`);
            if (row.claim_refusal !== null) {
              parts.push(`refusal="${escapeUnsafeDisplayChars(row.claim_refusal)}"`);
            }
            // Both ids for a binding denial (C4): the owning tenant's binding as
            // stored, and the presenting provider mapped back from its ref with
            // the app's own `providerRef` — the audit row carries only the ref,
            // so another customer's connection id is never shown to this tenant.
            if (bucket === UNMAPPED_BUCKET.PROVIDER_BINDING) {
              parts.push(
                `boundProvider=${row.bound_provider === null ? "-" : `"${escapeUnsafeDisplayChars(row.bound_provider)}"`}`,
              );
              parts.push(`signInProvider="${describeSignInProviderRef(row.sign_in_provider_ref, refMapping)}"`);
            }
            console.log(
              `  tenant=${row.tenant_id}  ${parts.join("  ")}  count=${Number(row.cnt)}  lastSeen=${new Date(row.last_seen).toISOString()}` +
                (undelivered > 0 ? `  undelivered=${undelivered}` : ""),
            );
          }
        };
        printGroup(
          "Unregistered claims — remedy: `tenant-domain add --tenant <ref> --domain <claim>`:",
          UNMAPPED_BUCKET.UNREGISTERED,
        );
        printGroup(
          "Claims registered to a DIFFERENT tenant — investigate the user, or move the claim with `add --from`:",
          UNMAPPED_BUCKET.OTHER_TENANT,
        );
        // "REFUSED", not "refused at ingest" (round-6 F1): the bucket now also
        // holds claims that PASS ingest and fail `storableClaimSchema` — SC9's
        // printable-ASCII narrowing. Both share the remedy this heading names,
        // and neither is registrable, which is what the heading has to convey.
        printGroup(
          "Claims this deployment REFUSED (at ingest, or as unstorable) — `add` cannot register them; the remedy is at the IdP:",
          UNMAPPED_BUCKET.REFUSED,
        );
        // Plan sso-claim-connection-binding, C4.
        printGroup(
          "Claims strict binding REFUSED for the presenting provider (unbound, or bound to another provider) — " +
            "investigate first: a mismatch is the signature of one connection's IdP asserting another customer's claim. " +
            "A claim registered by sign-in is bound to the provider that first presented it, so a claim squatted " +
            "through one connection is unusable through another until an operator acts. If the bound tenant was " +
            "created by sign-in through another customer's provider, re-point the claim to the rightful tenant with " +
            "`add --tenant <rightful> --domain <claim> --from <bound-tenant-uuid> --provider <theirs> --by <label>`; never `bind` the rightful " +
            "provider into it. An unbound claim whose tenant is the rightful owner is bound with `tenant-domain bind`:",
          UNMAPPED_BUCKET.PROVIDER_BINDING,
        );

        // S12: an empty result says so explicitly, with the window it
        // checked, rather than rendering as an indistinguishable empty list
        // — printed via `message` (not console.log here) so both the CLI
        // wrapper AND the integration test observe the identical text,
        // without depending on the shared dev DB happening to be globally
        // empty of unmapped-claim denials at test time.
        const message = formatUnmappedMessage(rows, days);

        return { ok: true, code: 0, rows, message };
      },
      BYPASS_GRANT.TENANT_DOMAIN_UNMAPPED_REPORT,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── shared: --by validation ────────────────────────────────────

// Sized to `tenant_claim_events.actor_label VARCHAR(255)`
// (prisma/migrations/20260731100000_add_tenant_claim_events) — the column
// every one of the five verbs writes `--by` into as attribution.
const ACTOR_LABEL_MAX_LENGTH = 255;

// Shared by `add` and `remove` (C4/#743): `--by` supplies `actor_label` on
// all four routing operations, not just the row `add` may create, so one
// validator sits ahead of both rather than a second hand-maintained copy
// drifting from the first (RT9 twin).
function validateActorLabel(by: string): CmdResult | null {
  if (!by || by.trim().length === 0) {
    return { ok: false, code: 1, message: "--by is required (a self-asserted operator label)." };
  }

  // `signin` is the label the auto-registration path writes, and it is the one
  // value a reader of `history` treats as engine-generated rather than typed by
  // a person. Every other `--by` is self-asserted and says so; this one would
  // borrow the credibility of the path that is not. Reserved at ingest — what
  // is stored stays what was typed, so it cannot be fixed on the way out, and
  // I1 makes the row uncorrectable afterwards. (`db_user` still distinguishes
  // the two, but only for a reader who thinks to look.)
  // CLASS: best-effort tripwire, not a boundary. Its two bypasses are named
  // rather than left to be discovered — a direct writer does not pass through
  // this function at all (the producer accepts any `actorLabel`, and the
  // completeness gate has no predicate on it), and `--by` is self-asserted by
  // construction. `db_user` is the real attribution. What this buys is that the
  // ONE label a `history` reader treats as engine-written cannot be typed by a
  // person at the sanctioned entry point.
  //
  // Every engine-written label, not only `signin` (plan
  // sso-claim-connection-binding, C3): `backfill` is the `created_by` the
  // claim-table migration wrote and `db-delete` the actor of the deregister
  // trigger, and the binding evidence reads both as provenance. Derived from
  // the label constants, with `signin`'s normalisation for all three.
  const reserved = ENGINE_WRITTEN_LABELS.find((label) => label === by.trim().toLowerCase());
  if (reserved !== undefined) {
    return {
      ok: false,
      code: 1,
      message:
        `--by must not be "${reserved}": that label is reserved for a path the engine writes ` +
        (reserved === SIGNIN_ACTOR_LABEL ? "(the sign-in auto-registration path)" : "") +
        ", and a routing event carrying it would read as engine-written rather than operator-asserted. " +
        "Use your own identifier.",
    };
  }

  // Refused here, before the client is even built, rather than left to the
  // column's own bound: a value this long would otherwise raise a raw 22001
  // mid-transaction, after the operator has already read the confirmation
  // prompt and answered it.
  if (by.length > ACTOR_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      code: 1,
      message: `--by is too long (${by.length} characters; max ${ACTOR_LABEL_MAX_LENGTH}).`,
    };
  }

  // `--by` is stored verbatim as this change's attribution — actor_label on
  // the tenant_claim_events row it appends, and, on `add`'s create arm only,
  // TenantClaim.createdBy — and read back by `history`. Neither column is
  // CHECK-constrained. A label carrying a bidi override would misrepresent
  // who made the change at exactly the moment someone is deciding whether to
  // trust the row. Rejected rather than escaped on the way in, matching the
  // claim ingest boundary: what is stored stays what was typed.
  if (UNSAFE_DISPLAY_CHARS_RE.test(by)) {
    return {
      ok: false,
      code: 1,
      message:
        "--by contains a control, bidi or zero-width character. Use a plain label: " +
        "it is stored as this change's attribution and read back by `history`.",
    };
  }

  // Printable ASCII. `actor_label` deliberately carries no CHECK (one
  // adjudicator per predicate, R48), so without this the field is full Unicode
  // and the reserved-label test below is defeated by a confusable — `ѕignin`
  // (Cyrillic U+0455) renders identically in `history` output. An operator
  // identifier needs nothing outside ASCII, so the narrowing costs nothing and
  // closes the class here rather than growing a second adjudicator elsewhere.
  if (!asciiPrintable.test(by)) {
    return {
      ok: false,
      code: 1,
      message:
        "--by must be printable ASCII. It is stored as this change's attribution and " +
        "read back by `history`, where a look-alike character would misrepresent who acted.",
    };
  }

  return null;
}

// ─── add ─────────────────────────────────────────────────────────

const ROW_6_9A_WARNING = [
  "Registering this claim does not only decide which NEW users land in this tenant:",
  "if any EXISTING bootstrap-tenant user's next sign-in presents this exact claim,",
  "their ENTIRE personal estate (password entries, vault key, attachments,",
  "emergency-access grants, shares, API keys, WebAuthn credentials, sessions,",
  "and audit history) is reassigned into this tenant on that sign-in.",
].join("\n");

const REASSIGNMENT_WARNING = [
  "Reassigning this claim takes it AWAY from the losing tenant shown above:",
  "from now on every sign-in presenting it selects the gaining tenant instead.",
  "A losing-tenant member who signs in through this claim and holds no other",
  "registered claim is denied from that moment on. Nothing already signed in is",
  "logged out, no data moves back, and no estate absorbed under the old owner is",
  "returned by this command.",
].join("\n");

/**
 * The binding `add` writes, from `--provider`/`--unbound` (plan
 * sso-claim-connection-binding, C3). Every writing arm — create, unrevoke and
 * the `--from` re-point — sets the row's provider to exactly what the operator
 * stated, so the flag is required rather than defaulted: in strict mode a
 * NULL row is refused (sign-in would refuse the claim), and outside strict one
 * is written only on an explicit `--unbound`.
 */
function resolveAddBinding(
  args: { provider?: string; unbound?: boolean; acceptUnusedProvider?: boolean },
  appEnv: AppEnv,
): { ok: true; provider: string | null } | { ok: false; result: CmdResult } {
  const refuse = (message: string) => ({ ok: false as const, result: { ok: false, code: 1, message } });
  if (args.provider !== undefined && args.unbound === true) {
    return refuse("--provider and --unbound contradict each other; give one.");
  }
  if (args.unbound === true && args.acceptUnusedProvider === true) {
    return refuse(
      "--accept-unused-provider overrides the member evidence for a --provider binding; an --unbound claim " +
        "has no provider to accept. Drop one of them.",
    );
  }
  if (args.provider === undefined) {
    if (appEnv.mode === CLAIM_BINDING_MODE.STRICT) {
      return refuse(
        "Claim binding is strict in this environment, and strict mode refuses a claim with no provider at " +
          "sign-in. Name the provider the tenant's users sign in through: --provider <id>" +
          (appEnv.present ? ` (configured: ${appEnv.claimProviders.join(", ")}).` : "."),
      );
    }
    if (args.unbound !== true) {
      return refuse(
        "State the claim's provider binding: --provider <id> for the SSO provider this tenant's users sign " +
          "in through, or --unbound to write the claim with no provider (strict mode refuses such a claim " +
          "at sign-in until `tenant-domain bind` binds it).",
      );
    }
    return { ok: true, provider: null };
  }
  const providerError = validateProviderFlag(args.provider, appEnv);
  return providerError ? { ok: false, result: providerError } : { ok: true, provider: args.provider };
}

export async function cmdAdd(args: {
  tenant: string;
  domain: string;
  by: string;
  from?: string;
  /** The full provider id the claim is bound to. */
  provider?: string;
  /** Write the claim with no provider; refused in strict mode. */
  unbound?: boolean;
  /** Proceed although the provider's users are not a majority of the tenant's members. */
  acceptUnusedProvider?: boolean;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  const app = readAppEnv();
  if (!app.ok) return app.result;
  const binding = resolveAddBinding(args, app.env);
  if (!binding.ok) return binding.result;
  const newProvider = binding.provider;

  // `--from` is the reassignment flag, and it takes a bare tenant UUID —
  // deliberately NOT the `<ref>` forms `--tenant` accepts. Reassignment is
  // the one operation here that can deny an entire existing tenant's members,
  // and the wrong-owner state it repairs is reachable with no operator action
  // at all (findOrCreateTenantForClaim auto-registers `createdBy: "signin"`
  // rows), so the guard has to be something a typo cannot produce. A UUID the
  // operator can only have got from `list` output is that; a domain or slug
  // one character off is exactly what put the claim on the wrong tenant.
  if (args.from !== undefined && !UUID_RE.test(args.from)) {
    return {
      ok: false,
      code: 1,
      message:
        `Invalid --from "${escapeUnsafeDisplayChars(args.from)}": expected the current owner's tenant UUID, ` +
        'exactly as "list" prints it. --from is not resolved through slugs or claims ' +
        "— a claim reassignment must not be reachable by a typo.",
    };
  }

  // Validated BEFORE any query, and before the client is even constructed
  // (operatorDomainSchema is the stricter of C2's two schemas — operators
  // register domains, and a typo caught here is cheaper than a row that
  // resolves nothing).
  const normalized = normalizeTenantClaim(args.domain);
  const parsed = operatorDomainSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      code: 1,
      message: `Invalid --domain "${escapeUnsafeDisplayChars(args.domain)}": ${parsed.error.issues[0]?.message ?? "does not satisfy operatorDomainSchema"} (example: alias.example)`,
    };
  }
  const claim = parsed.data;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const tenant = await resolveTenantRef(tx, args.tenant);
        if (!tenant) {
          return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(args.tenant)}` };
        }

        // Refused HERE and not in resolveTenantRef, which `list` and `history`
        // also call: those are how an operator DIAGNOSES a claim pointed at the
        // sentinel, and denying them would remove the diagnosis this refusal
        // exists to make unnecessary. `remove` is likewise left working — it is
        // a soft revoke that records a tenant_claim_event, i.e. the audited
        // undo, and refusing it would strand any deployment where the accident
        // already happened.
        //
        // Keyed on the RESOLVED id, not on the ref string. resolveTenantRef
        // takes UUID → existing claim, so the sentinel has TWO
        // spellings that reach here: its UUID, and any claim already pointing
        // at it — which is the spelling an operator uses during exactly the
        // incident this refusal is about. A check on the ref string would pass
        // for the second. (Its slug is not a third: slug is deliberately not a
        // resolution path.)
        //
        // `add` is the only creator of a sentinel claim. The sign-in JIT path
        // builds its claim as a nested write inside tenant.create, so it always
        // targets a NEW tenant.
        if (tenant.id === SYSTEM_TENANT_ID) {
          return {
            ok: false,
            code: 1,
            message:
              `Refusing to register a claim against the sentinel tenant ` +
              `(${tenant.slug}). It is the encoding of "no owning tenant" for ` +
              `audit rows that cannot be attributed, and its read-side safety ` +
              `rests on it having zero members. A claim here would route the ` +
              `next SSO sign-in from that domain into it, and the database now ` +
              `refuses that membership (tenant_members_not_system_tenant), so ` +
              `the sign-in would fail rather than succeed quietly.\n` +
              `Use "tenant-domain list" to find the tenant you meant.`,
          };
        }

        // The ONE tenantClaim.findUnique call site outside
        // tenant-management.ts's resolver (C3/C4): this command's D2
        // semantics need the owning tenant AND the revoked state, which
        // resolveTenantByClaim deliberately does not expose (it filters
        // revoked rows to null so sign-in cannot resurrect them silently).
        const existing = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true, createdBy: true, createdAt: true, provider: true },
        });

        if (args.from !== undefined && !existing) {
          return {
            ok: false,
            code: 1,
            message: `--from was given but claim "${escapeUnsafeDisplayChars(claim)}" is not registered to any tenant — there is nothing to reassign. Re-run without --from to register it.`,
          };
        }
        if (args.from !== undefined && existing && args.from !== existing.tenantId) {
          return {
            ok: false,
            code: 1,
            message: `--from ${escapeUnsafeDisplayChars(args.from)} does not own claim "${escapeUnsafeDisplayChars(claim)}" — tenant ${existing.tenantId} does. Refusing to reassign; naming the actual current owner is what makes this a deliberate act rather than a typo.`,
          };
        }

        const isReassignment = existing !== null && existing.tenantId !== tenant.id;

        // D2: a row owned by a DIFFERENT tenant is never reassigned
        // implicitly — but there has to BE a way to reassign it, or a claim
        // auto-registered onto a junk tenant by one mistyped sign-in is
        // permanent and the tool cannot fix the `tenant_mismatch` symptom it
        // is shipped for. `--from` is that way, and this message names it
        // instead of the old "run remove first" instruction, which looped:
        // `remove` soft-deletes (revokedAt) and leaves tenant_id unchanged,
        // so the next `add` re-entered this same branch.
        if (existing && isReassignment && args.from === undefined) {
          const state = existing.revokedAt ? "revoked and owned by" : "owned by";
          return {
            ok: false,
            code: 1,
            message:
              `Claim "${escapeUnsafeDisplayChars(claim)}" is ${state} tenant ${existing.tenantId}, not ${tenant.id}. ` +
              "Refusing to reassign implicitly. To move it, name the current owner: " +
              `add --tenant ${tenant.id} --domain ${escapeUnsafeDisplayChars(claim)} ` +
              `${newProvider === null ? "--unbound" : `--provider ${escapeUnsafeDisplayChars(newProvider)}`} ` +
              `--by <label> --from ${existing.tenantId}. ` +
              '("remove" does not free a claim — it soft-deletes, leaving the owner unchanged.)',
          };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);

        // D2 idempotency (VE2): already owned by this tenant and not
        // revoked — success, no write, no confirmation prompt (nothing is
        // about to mutate).
        if (existing && !isReassignment && existing.revokedAt === null) {
          printTenantSummary(tenant, activeMembers);
          // The binding the operator stated must hold too, or the flag was an
          // instruction silently not applied. Changing an active row's binding
          // is `bind`'s, which records it as a `rebind`.
          if (existing.provider !== newProvider) {
            return {
              ok: false,
              code: 1,
              message:
                `Claim "${escapeUnsafeDisplayChars(claim)}" is already registered to this tenant, bound to ` +
                `${existing.provider === null ? "no provider" : `"${escapeUnsafeDisplayChars(existing.provider)}"`}, not ` +
                `${newProvider === null ? "no provider" : `"${escapeUnsafeDisplayChars(newProvider)}"`}. No change made; ` +
                "change the binding with `tenant-domain bind --claim <claim> --provider <id> --by <label>`.",
            };
          }
          console.log(`Claim "${escapeUnsafeDisplayChars(claim)}" is already registered to this tenant. No change made.`);
          return { ok: true, code: 0, tenantId: tenant.id, claim, message: "already registered (idempotent)" };
        }

        printTenantSummary(tenant, activeMembers, isReassignment ? "Gaining tenant:" : "Tenant:");

        if (existing && isReassignment) {
          const losing = await tx.tenant.findUnique({
            where: { id: existing.tenantId },
            select: { id: true, name: true, slug: true },
          });
          const losingMembers = await activeMemberCount(tx, existing.tenantId);
          if (losing) {
            printTenantSummary(losing, losingMembers, "Losing tenant:");
          } else {
            // Unreachable while the FK holds; printed rather than assumed
            // away, because the blast radius is the whole point of this block.
            console.log(`Losing tenant:\n  id:             ${existing.tenantId} (no tenants row found)`);
          }
          console.log("");
          console.log(REASSIGNMENT_WARNING);
          console.log("");
        }

        console.log("Target claim row:");
        console.log(`  claim: ${escapeUnsafeDisplayChars(claim)}`);
        if (!existing) {
          console.log("  status: NEW — no existing row");
        } else if (existing.revokedAt) {
          console.log(
            `  status: REVOKED at ${existing.revokedAt.toISOString()} — this add will CLEAR revokedAt` +
              (isReassignment ? " and MOVE the row (D2 recovery + reassignment)" : " (D2 recovery)"),
          );
        } else {
          console.log("  status: ACTIVE — this add will MOVE the row to the gaining tenant");
        }
        if (existing) {
          // `createdBy` is an unvalidated operator-supplied label (`--by`), so
          // it is the one field here an earlier operator could have poisoned.
          const registeredBy =
            existing.createdBy === null ? "-" : escapeUnsafeDisplayChars(existing.createdBy);
          console.log(`  registered by: ${registeredBy} at ${existing.createdAt.toISOString()} (preserved)`);
          console.log(
            `  provider: ${existing.provider === null ? "none" : escapeUnsafeDisplayChars(existing.provider)} → ` +
              `${newProvider === null ? "none (--unbound)" : escapeUnsafeDisplayChars(newProvider)}`,
          );
        } else {
          console.log(`  provider: ${newProvider === null ? "none (--unbound)" : escapeUnsafeDisplayChars(newProvider)}`);
        }
        console.log("");

        // The evidence check every provider-setting writer runs, on the
        // tenant the claim will select (C3).
        const evidence = await readMemberEvidence(tx, tenant.id, app.env, newProvider);
        const provenance = existing
          ? await readProvenance(tx, claim, existing.tenantId, existing.createdBy)
          : null;
        printEvidence(tenant.id, evidence, provenance);
        if (newProvider !== null) {
          const refusal = majorityRefusal(evidence, newProvider, args.acceptUnusedProvider === true);
          if (refusal) return refusal;
        }
        console.log("");
        console.log(ROW_6_9A_WARNING);

        const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
        if (!confirmed) {
          return { ok: false, code: 1, message: "Aborted: not confirmed." };
        }

        // Reassignment does NOT require the row to be revoked first, and the
        // choice is deliberate. Revoke-first would add a step without adding
        // a check — `--from` already supplies the "name the losing side"
        // deliberateness that the requirement would be standing in for — and
        // it would open a window in which the claim resolves to nobody, so
        // BOTH tenants' members are denied until the second command lands.
        // Trading a single atomic move for a self-inflicted lockout window is
        // the wrong direction for a tool whose reason to exist is ending
        // lockouts. A revoked row is reassignable too, and comes out active:
        // the operator asked for this claim to select the gaining tenant.
        //
        // updateMany with the owner re-asserted in WHERE, not update(): the
        // confirmation prompt runs inside this transaction (D-14) but the
        // read happened before the human answered, so a concurrent change
        // must surface as count === 0 — a clean refusal — never as a silent
        // overwrite of an owner the operator was never shown.
        //
        // `revokedAt` is part of the compare-and-swap, not just `tenantId`
        // (round-6, raised independently by Codex). The preview above prints
        // the row's revocation state and this write CLEARS it, so a concurrent
        // `remove` landing while the operator reads the warning was silently
        // undone: the move succeeded and set `revokedAt: null`, reversing
        // another operator's incident containment with no notice to either of
        // them. Every field the preview showed and this write changes has to be
        // in the WHERE, or the CAS only covers the fields someone remembered.
        if (existing && isReassignment) {
          // `provider` joins the CAS for the same reason (C3): this write
          // replaces the binding the preview showed.
          const moved = await tx.tenantClaim.updateMany({
            where: {
              id: existing.id,
              tenantId: existing.tenantId,
              revokedAt: existing.revokedAt,
              provider: existing.provider,
            },
            data: { tenantId: tenant.id, revokedAt: null, provider: newProvider },
          });
          if (moved.count === 0) {
            return {
              ok: false,
              code: 1,
              message: `Claim "${escapeUnsafeDisplayChars(claim)}" was modified concurrently by another process. Re-run "list" to see its current owner.`,
            };
          }
          // C4/#743: one event, in the same transaction, naming both sides —
          // the losing tenant this row moved FROM and the gaining tenant it
          // moved TO — so a reassignment is one incident, not two groups.
          await recordTenantClaimEvent(tx, {
            claim,
            operation: TENANT_CLAIM_EVENT_OPERATION.REASSIGN,
            oldTenantId: existing.tenantId,
            newTenantId: tenant.id,
            oldRevokedAt: existing.revokedAt,
            newRevokedAt: null,
            actorLabel: args.by,
            oldProvider: existing.provider,
            newProvider,
          });
        } else if (existing) {
          // M2 / SC8: `createdBy` is NOT overwritten with `--by`. SC8 defers
          // application-level audit for claim registration on the premise
          // that "the row itself carries the timeline and the self-asserted
          // actor an incident needs" — overwriting it on the un-revoke path
          // erased exactly that, leaving no record of who first registered
          // the claim. The un-revoker is recorded separately, as actor_label
          // on the tenant_claim_events row appended below (SC11 / #743) —
          // TenantClaim itself still needs no new column for it.
          // Same total CAS as the reassignment above: the row was revoked when
          // it was read, and it is the revocation this write clears, so a
          // concurrent change to either field is a refusal rather than a
          // silent overwrite.
          const unrevoked = await tx.tenantClaim.updateMany({
            where: { id: existing.id, tenantId: tenant.id, revokedAt: existing.revokedAt, provider: existing.provider },
            data: { revokedAt: null, provider: newProvider },
          });
          if (unrevoked.count === 0) {
            return {
              ok: false,
              code: 1,
              message: `Claim "${escapeUnsafeDisplayChars(claim)}" was modified concurrently by another process. Re-run "list" to see its current state.`,
            };
          }
          await recordTenantClaimEvent(tx, {
            claim,
            operation: TENANT_CLAIM_EVENT_OPERATION.UNREVOKE,
            oldTenantId: tenant.id,
            newTenantId: tenant.id,
            oldRevokedAt: existing.revokedAt,
            newRevokedAt: null,
            actorLabel: args.by,
            oldProvider: existing.provider,
            newProvider,
          });
        } else {
          try {
            await tx.tenantClaim.create({ data: { tenantId: tenant.id, claim, createdBy: args.by, provider: newProvider } });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
              return {
                ok: false,
                code: 1,
                message: `Claim "${escapeUnsafeDisplayChars(claim)}" was registered concurrently by another process. Re-run "list" to see its current owner.`,
              };
            }
            throw e;
          }
          await recordTenantClaimEvent(tx, {
            claim,
            operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
            oldTenantId: null,
            newTenantId: tenant.id,
            oldRevokedAt: null,
            newRevokedAt: null,
            actorLabel: args.by,
            oldProvider: null,
            newProvider,
          });
        }

        if (existing && isReassignment) {
          console.log(`Reassigned claim "${escapeUnsafeDisplayChars(claim)}" from tenant ${existing.tenantId} to tenant ${tenant.id}.`);
        } else if (existing) {
          console.log(`Un-revoked claim "${escapeUnsafeDisplayChars(claim)}" for tenant ${tenant.id}.`);
        } else {
          console.log(`Registered claim "${escapeUnsafeDisplayChars(claim)}" for tenant ${tenant.id}.`);
        }
        if (existing) {
          // Escaped for the same reason as the preview above (round-4 F4 —
          // the A3 sweep missed this one, 80 lines from the site it did fix).
          // `args.by` is the operator's own input and has already been
          // rejected if it carries an unsafe character, so it is printed as
          // typed.
          const registeredBySoFar =
            existing.createdBy === null ? "-" : escapeUnsafeDisplayChars(existing.createdBy);
          console.log(
            `createdBy stays "${registeredBySoFar}" (${existing.createdAt.toISOString()}) — the row records who ` +
              `FIRST registered this claim, not who last changed it. This change was made by "${escapeUnsafeDisplayChars(args.by)}"; ` +
              `see "tenant-domain history --domain ${escapeUnsafeDisplayChars(claim)}" for the full record of who changed what, and when.`,
          );
          // What this write overwrites on THIS row, named explicitly (round-6,
          // Codex — see plan SC11). SC8 defers application-level audit on the
          // grounds that "the row itself carries the timeline"; that is true
          // of register-then-revoke and false of both operations below,
          // because each overwrites the state it changed. SC11's append-only
          // `tenant_claim_events` table now records it (queryable with
          // `tenant-domain history`), so this line names the values rather
          // than claiming they are lost.
          const overwritten: string[] = [];
          if (isReassignment) overwritten.push(`previous owner tenant ${existing.tenantId}`);
          if (existing.revokedAt !== null) {
            overwritten.push(`revokedAt ${existing.revokedAt.toISOString()}`);
          }
          if (existing.provider !== newProvider) {
            overwritten.push(`provider ${existing.provider === null ? "none" : escapeUnsafeDisplayChars(existing.provider)}`);
          }
          if (overwritten.length > 0) {
            console.log(
              `Overwritten on this row (not lost — recorded in tenant_claim_events; read it with the ` +
                `"history" command shown above): ${overwritten.join("; ")}.`,
            );
          }
        }
        console.log(
          "Reminder: if this deployment sets GOOGLE_WORKSPACE_DOMAINS, src/auth.config.ts's " +
            "signIn callback (:207-215) denies any Google sign-in whose `hd` is not in that list " +
            "BEFORE tenant resolution runs. Registering this claim alone changes nothing for such " +
            "a deployment, and \"unmapped\" will keep showing nothing for it, until the domain is " +
            "also added to GOOGLE_WORKSPACE_DOMAINS.",
        );

        return { ok: true, code: 0, tenantId: tenant.id, claim };
      },
      BYPASS_GRANT.TENANT_CLAIM_BINDING_WRITE,
      confirmationTransaction.options(),
    );
  } catch (e) {
    const timedOut = confirmationTimeoutResult(e);
    if (timedOut) return timedOut;
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── remove ──────────────────────────────────────────────────────

export async function cmdRemove(args: {
  tenant: string;
  domain: string;
  by: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  // Validated here — before the client is constructed, next to the
  // --domain check below — not inside withBypassRls's callback. "Before the
  // CAS write" would be too weak: a refusal raised once the transaction is
  // open happens AFTER the operator has read the warning and answered the
  // confirmation prompt, which is the false-deny on an incident-response
  // path C1 exists to avoid.
  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  // storableClaimSchema, NOT operatorDomainSchema (round-3 S3-13). The
  // operator-input guard belongs on the write that CREATES a row; applying
  // it here would make a legitimately stored non-domain claim (`acmecorp`,
  // or a backfilled value) unremovable.
  const normalized = normalizeTenantClaim(args.domain);
  const parsed = storableClaimSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      code: 1,
      message: `Invalid --domain "${escapeUnsafeDisplayChars(args.domain)}": ${parsed.error.issues[0]?.message ?? "does not satisfy storableClaimSchema"}`,
    };
  }
  const claim = parsed.data;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const tenant = await resolveTenantRef(tx, args.tenant);
        if (!tenant) {
          return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(args.tenant)}` };
        }

        const existing = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true, createdAt: true, provider: true },
        });
        if (!existing) {
          return { ok: false, code: 1, message: `No claim "${escapeUnsafeDisplayChars(claim)}" is registered to any tenant.` };
        }

        // Round-2 S4: `claim` is globally unique, so without this check
        // `remove --domain <typo>` would reach into ANY tenant and deny
        // every one of its members at their next sign-in.
        if (existing.tenantId !== tenant.id) {
          return {
            ok: false,
            code: 1,
            message: `Claim "${escapeUnsafeDisplayChars(claim)}" is owned by tenant ${existing.tenantId}, not ${tenant.id}. Refusing to remove.`,
          };
        }

        if (existing.revokedAt !== null) {
          console.log(`Claim "${escapeUnsafeDisplayChars(claim)}" is already revoked (since ${existing.revokedAt.toISOString()}). No change made.`);
          return { ok: true, code: 0, tenantId: tenant.id, claim, message: "already revoked (idempotent)" };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);
        printTenantSummary(tenant, activeMembers);
        console.log("Target claim row:");
        console.log(`  claim:     ${escapeUnsafeDisplayChars(claim)}`);
        console.log(`  createdAt: ${existing.createdAt.toISOString()}`);
        console.log("");
        console.log(
          "Removing this claim means any FUTURE sign-in presenting it is denied with " +
            "tenant_claim_unmapped until it is registered again (to this tenant or another). " +
            "It does not affect users already signed in, and does not touch any existing session.",
        );

        const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
        if (!confirmed) {
          return { ok: false, code: 1, message: "Aborted: not confirmed." };
        }

        // updateMany (not update): an explicit count === 0 is a clean
        // refusal, where update()'s equivalent miss would throw P2025.
        // Soft delete (revokedAt), never DELETE — a claim's lifetime must
        // survive the incident response that discovers it (round-3 S3-4);
        // createdAt is one of the two timestamps C12's runbook needs.
        //
        // Hoisted rather than inlined into `data`: the event below must
        // record the SAME instant that was written, not a second
        // `new Date()` a few microseconds later.
        //
        // The provider is part of the CAS because the event records it: a
        // rebind committed while the operator read the prompt would otherwise
        // be revoked under an event naming the provider it replaced.
        const revokedAt = new Date();
        const result = await tx.tenantClaim.updateMany({
          where: { claim, tenantId: tenant.id, revokedAt: null, provider: existing.provider },
          data: { revokedAt },
        });
        if (result.count === 0) {
          return {
            ok: false,
            code: 1,
            message: `Claim "${escapeUnsafeDisplayChars(claim)}" was modified concurrently by another process. Re-run "list" to see its current state.`,
          };
        }
        await recordTenantClaimEvent(tx, {
          claim,
          operation: TENANT_CLAIM_EVENT_OPERATION.REVOKE,
          oldTenantId: tenant.id,
          newTenantId: tenant.id,
          oldRevokedAt: null,
          newRevokedAt: revokedAt,
          actorLabel: args.by,
          oldProvider: existing.provider,
          newProvider: existing.provider,
        });

        console.log(`Revoked claim "${escapeUnsafeDisplayChars(claim)}" for tenant ${tenant.id}.`);
        return { ok: true, code: 0, tenantId: tenant.id, claim };
      },
      BYPASS_GRANT.TENANT_CLAIM_REGISTER,
      confirmationTransaction.options(),
    );
  } catch (e) {
    const timedOut = confirmationTimeoutResult(e);
    if (timedOut) return timedOut;
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── history ─────────────────────────────────────────────────────

// A named cap rather than an unbounded read (external review finding, C6 /
// SC11): a claim or tenant with a long routing history — a squatted domain
// bounced between tenants over months, say — must not turn one `history`
// call into an unbounded table scan at incident time. Chosen well above any
// history this deployment shape plausibly has (SC-A: one row per operator
// mutation) so it is a backstop, not a paging scheme an operator hits in
// normal use. When it IS hit, the tool prints the exact re-invocation to
// continue (below) — silently truncating an incident-response read path is
// worse than stopping and saying so.
export const HISTORY_ROW_CAP = 500;

export async function cmdHistory(args: {
  domain?: string;
  tenant?: string;
  /** Continuation cursor: `seq` of the last row a previous, capped call printed. */
  after?: string;
  /**
   * Test seam, never a CLI flag: overrides HISTORY_ROW_CAP so the truncation
   * and continuation-message path can be red-proved without inserting
   * HISTORY_ROW_CAP+1 real rows. Same shape as `migrationClientFactory` and
   * `confirm` above — a real production default with an override only tests
   * reach.
   */
  rowCap?: number;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();
  const rowCap = args.rowCap ?? HISTORY_ROW_CAP;

  // Validated before the client is built, same convention as `unmapped`'s
  // `--days`: `--after` is meant to be re-typed verbatim from this command's
  // own previous output, so a non-digit value is almost certainly a copy
  // mistake worth catching immediately rather than one `seq` comparison
  // matching nothing.
  let afterSeq: bigint | undefined;
  if (args.after !== undefined) {
    if (!/^\d+$/.test(args.after)) {
      return {
        ok: false,
        code: 1,
        message:
          `Invalid --after "${escapeUnsafeDisplayChars(args.after)}": expected the seq cursor ` +
          "printed by a capped history result (a non-negative integer).",
      };
    }
    afterSeq = BigInt(args.after);
  }

  // ONE predicate for both the guard and the selector choice. They used to
  // disagree — the guard tested truthiness, the choice tested definedness — so
  // `history --tenant <uuid> --domain ""` passed the guard, took the claim
  // branch with an empty claim, and reported an empty result for a question the
  // operator did not ask. A flag the operator wrote must either take effect or
  // stop the command; this module's own header says so.
  // `!== undefined` alone is not enough: `parseFlags` refuses only the inline
  // empty spelling (`--domain=`), so the space-separated `--domain ""` arrives
  // as `""`. Under a truthiness guard that was refused; under a definedness
  // guard it would take the claim branch and report "No routing history" with
  // exit 0 — evidence of absence, with a success code, on the incident-response
  // read path, from a runbook line whose variable happened to be unset. An
  // empty selector is refused below rather than reclassified as absent.
  const emptySelector =
    (args.domain !== undefined && args.domain.trim() === "") ||
    (args.tenant !== undefined && args.tenant.trim() === "");
  if (emptySelector) {
    return {
      ok: false,
      code: 1,
      message:
        "history was given an empty --domain/--tenant value. Refusing rather than " +
        "reporting an empty result: an empty selector cannot distinguish " +
        '"nothing matched" from "the variable you passed was unset".',
    };
  }
  const hasDomain = args.domain !== undefined;
  const hasTenant = args.tenant !== undefined;
  if (!hasDomain && !hasTenant) {
    return {
      ok: false,
      code: 1,
      message: "history requires --domain <claim> or --tenant <uuid>.",
    };
  }
  if (hasDomain && hasTenant) {
    return {
      ok: false,
      code: 1,
      message:
        "history takes --domain <claim> OR --tenant <uuid>, not both. " +
        "Re-run with the one you meant: --domain names a single claim, " +
        "--tenant every event naming that tenant on either side.",
    };
  }

  // Normalised the same way `add`/`remove` read `--domain` back, but
  // NOT schema-validated: this is a read, and a pre-existing row stored by
  // some other means must still be findable by it.
  const claim = hasDomain ? normalizeTenantClaim(args.domain as string) : undefined;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        let tenantId: string | undefined;
        if (claim === undefined) {
          const ref = args.tenant as string; // guaranteed by the neither-given refusal above
          // A bare UUID matches old_tenant_id/new_tenant_id DIRECTLY, never
          // through resolveTenantRef: every arm of that helper reads a LIVE
          // `tenants`/`tenant_claims` row, and all of them are dead in the one
          // case this selector exists for — a tenant deleted after a claim
          // was moved off it (F3). A non-UUID ref still resolves through it,
          // same as `list`/`add`/`remove`.
          if (UUID_RE.test(ref)) {
            tenantId = ref;
          } else {
            const tenant = await resolveTenantRef(tx, ref);
            if (!tenant) {
              return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(ref)}` };
            }
            tenantId = tenant.id;
          }
        }

        // seq (20260731170000), not createdAt: createdAt is millisecond-
        // precision and same-millisecond writes have no defined order under
        // it, so it can no longer be the read order or the pagination
        // cursor — only the displayed time. Fetches one row past the cap so
        // truncation is DETECTED rather than merely assumed whenever the
        // result happens to be exactly rowCap long.
        const take = rowCap + 1;
        const afterFilter = afterSeq !== undefined ? { seq: { gt: afterSeq } } : {};
        const page = { orderBy: { seq: "asc" }, take } as const;

        // The tenant selector is TWO queries rather than one `OR`. Measured
        // with EXPLAIN (ANALYZE) against 20260731190000's indexes: the `OR`
        // does use them, as a BitmapOr — but a bitmap scan produces no
        // ordering, so the plan is BitmapOr → Sort → Limit and the cap stops
        // bounding the work. Every matching row is read and sorted however
        // small the cap is. One equality per side walks (tenant, seq) in
        // order, so the plan is Index Scan → Limit with no sort at all, and
        // each side stops at the cap.
        //
        // Merging them is exact rather than approximate: the union's first
        // `take` rows by seq are necessarily a subset of (first `take` of the
        // old-tenant side) ∪ (first `take` of the new-tenant side), so
        // sorting the two capped pages and re-cutting to `take` yields the
        // same rows the single ordered query would have. `seq` is UNIQUE, so
        // it also de-duplicates the rows that name the tenant on BOTH sides —
        // every non-reassign event does.
        const fetched =
          claim !== undefined
            ? await tx.tenantClaimEvent.findMany({ where: { claim, ...afterFilter }, ...page })
            : await (async () => {
                // Sequential, not Promise.all: these share one interactive
                // transaction client, which Prisma does not support issuing
                // concurrent queries on.
                const asOld = await tx.tenantClaimEvent.findMany({
                  where: { oldTenantId: tenantId, ...afterFilter },
                  ...page,
                });
                const asNew = await tx.tenantClaimEvent.findMany({
                  where: { newTenantId: tenantId, ...afterFilter },
                  ...page,
                });
                const bySeq = new Map([...asOld, ...asNew].map((r) => [r.seq, r]));
                return [...bySeq.values()]
                  .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
                  .slice(0, take);
              })();
        const truncated = fetched.length > rowCap;
        const rows = truncated ? fetched.slice(0, rowCap) : fetched;

        // Every free-text/echoed column is escaped, unconditionally — not
        // only the ones this PR's own writers can produce. A row can predate
        // this PR's ingest boundaries (a `db_user` naming a role dropped
        // since, an `actor_label` from before validateActorLabel existed), and
        // check-operator-echo-escaped.mjs structurally cannot see any of
        // this: it taints process.argv and `cmd*` parameters, not values that
        // came out of the database. `oldTenantId`/`newTenantId` are UUIDs, not
        // free text, and left unescaped like `list`'s `tenantId` column.
        //
        // For EVERY row, not branched by `operation` — `operation` names the
        // primary verb but is not a partition (C3), so a reader filtering on
        // it for "did this touch tenant X" or "was this row revoked before"
        // gets the wrong answer for a `reassign` row. Printing both tenants
        // and both revocation values on every row, always, is what makes
        // that question answerable without knowing the operation first.
        for (const row of rows) {
          console.log(
            `${row.createdAt.toISOString()}\t${row.operation}\t` +
              `claim=${escapeUnsafeDisplayChars(row.claim)}\t` +
              `oldTenant=${row.oldTenantId ?? "-"}\tnewTenant=${row.newTenantId ?? "-"}\t` +
              `oldRevokedAt=${row.oldRevokedAt ? row.oldRevokedAt.toISOString() : "-"}\t` +
              `newRevokedAt=${row.newRevokedAt ? row.newRevokedAt.toISOString() : "-"}\t` +
              // Both bindings on every row, for the same reason as both
              // tenants: a `reassign` or `unrevoke` can change the provider
              // too, not only a `rebind`. CHECK-constrained ids, escaped anyway.
              `oldProvider=${row.oldProvider === null ? "-" : escapeUnsafeDisplayChars(row.oldProvider)}\t` +
              `newProvider=${row.newProvider === null ? "-" : escapeUnsafeDisplayChars(row.newProvider)}\t` +
              `by=${escapeUnsafeDisplayChars(row.actorLabel)}\t` +
              `dbUser=${escapeUnsafeDisplayChars(row.dbUser)}\t` +
              `sessionDbUser=${escapeUnsafeDisplayChars(row.sessionDbUser)}`,
          );
        }

        const subject =
          claim !== undefined
            ? `claim "${escapeUnsafeDisplayChars(claim)}"`
            // `tenantId` can be the raw --tenant value verbatim (the UUID
            // branch above), so it is echoed the same as any other operator
            // input even though UUID_RE already constrains its shape.
            : `tenant ${escapeUnsafeDisplayChars(tenantId ?? "")}`;

        if (truncated) {
          const lastSeq = rows[rows.length - 1].seq.toString();
          // How to continue, WITHOUT rebuilding the selector into the line.
          //
          // The earlier version printed a ready-to-paste
          // `tenant-domain history --domain <claim> --after <seq>`. A claim is
          // printable ASCII by CHECK constraint, which admits `;`, `$(…)` and
          // backticks, and `escapeUnsafeDisplayChars` neutralises terminal
          // control sequences — it is not a shell quoter and does not claim to
          // be. So a claim registered by anyone who can reach the
          // auto-registration path could put a command into a line an operator
          // is being invited to paste into a shell, during an incident.
          //
          // Quoting it correctly would work and is not what this does: the
          // operator already has the command they just ran, so naming the one
          // flag to add carries the same information with nothing interpolated
          // into command position at all. `lastSeq` is a BigInt read from the
          // database, printed as digits.
          //
          // Two lines, and the split is the point rather than formatting: the
          // second one is what an operator copies, and it carries nothing but
          // a flag name and digits. `subject` names the claim and stays on the
          // first line, escaped like every other display string this tool
          // prints — describing what was truncated is not the same act as
          // handing over something to run.
          //
          // "appended" only for the FIRST page. `parseFlags` refuses a repeated
          // flag outright (round-4 S5: a flag the operator wrote must either
          // take effect or stop the command), so from page 3 on, appending is
          // an instruction that exits 1 with no rows — an incident read path
          // telling the operator to do something it will then refuse. The old
          // value is not echoed back: naming the flag to replace says the same
          // thing without putting operator input in the line at all.
          const continuation =
            args.after === undefined
              ? `with --after ${lastSeq} appended`
              : `with --after ${lastSeq} in place of the --after already on it`;
          console.log(
            // operator-echo-exempt: `rowCap` is a number (HISTORY_ROW_CAP,
            // or the test-only `rowCap` seam — never a CLI flag), not
            // operator text, same as `unmapped`'s `days` above.
            `Capped at ${rowCap} rows; more events exist for ${subject}.\n` +
              `Continue by re-running the SAME command ${continuation}.`,
          );
        }

        const message =
          rows.length === 0
            ? `No routing history for ${subject}.`
            : truncated
              ? // operator-echo-exempt: `rowCap` is a number, not operator text.
                `${rows.length} event(s) listed (capped at ${rowCap} — see the continuation hint printed above).`
              : `${rows.length} event(s) listed.`;

        return { ok: true, code: 0, rows, message };
      },
      BYPASS_GRANT.TENANT_CLAIM_HISTORY,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── bind ────────────────────────────────────────────────────────

/** How one `bind --apply` line ended. */
export const BIND_LINE_OUTCOME = {
  BOUND: "bound",
  ALREADY_BOUND: "already bound",
  /** The row is no longer the unbound row of the line's tenant. */
  CAS_LOST: "CAS lost",
  /** The recomputed evidence differs from the line's. */
  EVIDENCE_CHANGED: "evidence changed",
  /** No active members, or the provider's users are not a majority. */
  EVIDENCE_REFUSED: "evidence refused",
} as const;

export type BindLineOutcome = (typeof BIND_LINE_OUTCOME)[keyof typeof BIND_LINE_OUTCOME];

/**
 * Change an active row's provider binding and record it — the one `rebind`
 * writer, shared by `bind` and `bind --apply`.
 *
 * Compare-and-swap on `(tenant_id, provider, revoked_at)`: the row must still
 * select the tenant, carry the binding and be active as read, so a concurrent
 * re-point, `remove` or second bind is a refusal rather than an overwrite of a
 * state the operator was never shown.
 */
async function rebindInTx(
  tx: TxClient,
  row: { id: string; claim: string; tenantId: string; provider: string | null },
  provider: string,
  by: string,
): Promise<boolean> {
  const rebound = await tx.tenantClaim.updateMany({
    where: { id: row.id, tenantId: row.tenantId, provider: row.provider, revokedAt: null },
    data: { provider },
  });
  if (rebound.count === 0) return false;
  await recordTenantClaimEvent(tx, {
    claim: row.claim,
    operation: TENANT_CLAIM_EVENT_OPERATION.REBIND,
    oldTenantId: row.tenantId,
    newTenantId: row.tenantId,
    oldRevokedAt: null,
    newRevokedAt: null,
    actorLabel: by,
    oldProvider: row.provider,
    newProvider: provider,
  });
  return true;
}

/**
 * `tenant-domain bind --claim <c> --provider <id> --by <label>`: bind one
 * active claim to a provider, or move its binding (plan
 * sso-claim-connection-binding, C3). The same evidence check as `add`; the
 * same-provider case is a no-op; a revoked or absent claim is refused — `add`
 * is how a claim is registered or un-revoked, and it takes `--provider` too.
 */
export async function cmdBind(args: {
  claim: string;
  provider: string;
  by: string;
  acceptUnusedProvider?: boolean;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  const app = readAppEnv();
  if (!app.ok) return app.result;
  const providerError = validateProviderFlag(args.provider, app.env);
  if (providerError) return providerError;

  // storableClaimSchema, as `remove` reads one: a stored non-domain claim
  // (a backfilled tenant id, a sign-in-registered value) must be bindable.
  const parsed = storableClaimSchema.safeParse(normalizeTenantClaim(args.claim));
  if (!parsed.success) {
    return {
      ok: false,
      code: 1,
      message: `Invalid --claim "${escapeUnsafeDisplayChars(args.claim)}": ${parsed.error.issues[0]?.message ?? "does not satisfy storableClaimSchema"}`,
    };
  }
  const claim = parsed.data;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const row = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true, provider: true, createdBy: true },
        });
        if (!row) {
          return {
            ok: false,
            code: 1,
            message:
              `No claim "${escapeUnsafeDisplayChars(claim)}" is registered. Register it with ` +
              "`add --tenant <ref> --domain <claim> --provider <id> --by <label>`.",
          };
        }
        if (row.revokedAt !== null) {
          return {
            ok: false,
            code: 1,
            message:
              `Claim "${escapeUnsafeDisplayChars(claim)}" is revoked (since ${row.revokedAt.toISOString()}). ` +
              "bind changes an active claim's binding only; `add --provider <id>` un-revokes it with its binding.",
          };
        }
        if (row.provider === args.provider) {
          return {
            ok: true,
            code: 0,
            tenantId: row.tenantId,
            claim,
            message: `Claim "${escapeUnsafeDisplayChars(claim)}" is already bound to "${escapeUnsafeDisplayChars(args.provider)}". No change made.`,
          };
        }

        const tenant = await tx.tenant.findUnique({
          where: { id: row.tenantId },
          select: { id: true, name: true, slug: true },
        });
        if (tenant) printTenantSummary(tenant, await activeMemberCount(tx, tenant.id));
        console.log("Target claim row:");
        console.log(`  claim:    ${escapeUnsafeDisplayChars(claim)}`);
        console.log(
          `  provider: ${row.provider === null ? "none" : escapeUnsafeDisplayChars(row.provider)} → ${escapeUnsafeDisplayChars(args.provider)}`,
        );
        console.log("");
        const evidence = await readMemberEvidence(tx, row.tenantId, app.env, args.provider);
        printEvidence(row.tenantId, evidence, await readProvenance(tx, claim, row.tenantId, row.createdBy));
        const refusal = majorityRefusal(evidence, args.provider, args.acceptUnusedProvider === true);
        if (refusal) return refusal;
        console.log("");
        console.log(
          "From now on, a sign-in presenting this claim selects this tenant only through the provider above " +
            "(in strict mode); a sign-in through any other provider is refused.",
        );

        const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
        if (!confirmed) {
          return { ok: false, code: 1, message: "Aborted: not confirmed." };
        }

        if (!(await rebindInTx(tx, { ...row, claim }, args.provider, args.by))) {
          return {
            ok: false,
            code: 1,
            message: `Claim "${escapeUnsafeDisplayChars(claim)}" was modified concurrently by another process. Re-run "list" to see its current state.`,
          };
        }
        console.log(
          `Bound claim "${escapeUnsafeDisplayChars(claim)}" to "${escapeUnsafeDisplayChars(args.provider)}" ` +
            `(was ${row.provider === null ? "unbound" : `"${escapeUnsafeDisplayChars(row.provider)}"`}).`,
        );
        return { ok: true, code: 0, tenantId: row.tenantId, claim };
      },
      BYPASS_GRANT.TENANT_CLAIM_BINDING_WRITE,
      confirmationTransaction.options(),
    );
  } catch (e) {
    const timedOut = confirmationTimeoutResult(e);
    if (timedOut) return timedOut;
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

/** This CLI's own directory: `--out` is checked against the worktree it lives in. */
const CLI_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The git worktrees a bind file must not be written into: the one this CLI
 * lives in and the one the operator runs it from, by `git rev-parse
 * --show-toplevel`. A directory that is not in a worktree (or a host without
 * git) contributes none.
 */
function gitWorktreeTops(): string[] {
  const tops = new Set<string>();
  for (const cwd of [CLI_DIR, process.cwd()]) {
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (top) tops.add(top);
    } catch {
      // Not inside a work tree, or no git binary: nothing to protect there.
    }
  }
  return [...tops];
}

/**
 * `bind --from-members --out <file>`: the first half of the upgrade path. Writes
 * one line per active claim with no provider — the tenant, the member evidence,
 * a provider suggestion when the members are unanimous, and the provenance flags
 * on a comment line above — for the operator to review. Writes nothing to the
 * database.
 *
 * The file lists every tenant's claims, so it is refused inside a git worktree
 * (by realpath, so a symlinked parent or `..` cannot carry it in), created
 * exclusively (an existing path is never overwritten) with mode 0600.
 */
export async function cmdBindFromMembers(args: { out: string }): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const app = readAppEnv();
  if (!app.ok) return app.result;
  if (!app.env.present) return appEnvRequiredResult("bind --from-members");
  const appEnv = app.env;

  for (const top of gitWorktreeTops()) {
    let inside: boolean;
    try {
      inside = isInsideWorktree(args.out, top);
    } catch {
      return {
        ok: false,
        code: 1,
        message: `--out "${escapeUnsafeDisplayChars(args.out)}": its directory does not exist.`,
      };
    }
    if (inside) {
      return {
        ok: false,
        code: 1,
        message:
          `--out "${escapeUnsafeDisplayChars(args.out)}" is inside the git worktree ${escapeUnsafeDisplayChars(top)}. ` +
          "The bind file lists every tenant's claims; write it outside the repository.",
      };
    }
  }

  let fd: number;
  try {
    // "wx": exclusive create — an existing path is refused, never overwritten.
    fd = openSync(args.out, "wx", 0o600);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "unknown";
    return {
      ok: false,
      code: 1,
      message:
        code === "EEXIST"
          ? `--out "${escapeUnsafeDisplayChars(args.out)}" already exists. Refusing to overwrite it; choose a new path.`
          : `--out "${escapeUnsafeDisplayChars(args.out)}" cannot be created (${escapeUnsafeDisplayChars(code)}).`,
    };
  }

  const prisma = migrationClientFactory.create(url);
  let written = false;
  try {
    // The umask can only narrow the mode `open` was given; this states it.
    fchmodSync(fd, 0o600);
    const rows = await withBypassRls(
      prisma,
      async (tx) => {
        const unbound = await tx.tenantClaim.findMany({
          where: { provider: null, revokedAt: null },
          select: { claim: true, tenantId: true, createdBy: true },
          orderBy: { claim: "asc" },
        });
        const out: BindFileRow[] = [];
        for (const row of unbound) {
          out.push({
            claim: row.claim,
            tenantId: row.tenantId,
            evidence: await readMemberEvidence(tx, row.tenantId, appEnv, null),
            flags: await readProvenance(tx, row.claim, row.tenantId, row.createdBy),
          });
        }
        return out;
      },
      BYPASS_GRANT.TENANT_CLAIM_BINDING_READ,
    );
    writeSync(fd, formatBindFile(rows));
    written = true;
    const lines = rows.filter((row) => isBindFileWritable(row.claim));
    const notWritten = rows.filter((row) => !isBindFileWritable(row.claim));
    const suggested = lines.filter((row) => suggestedProvider(row.evidence) !== null).length;
    return {
      ok: true,
      code: 0,
      rows,
      message:
        `Wrote ${lines.length} unbound claim(s) to ${escapeUnsafeDisplayChars(args.out)} (mode 0600); ` +
        `${suggested} carry a suggested provider. Review and edit the provider column, then run ` +
        "`bind --apply <file> --by <label>`. Delete the file afterwards." +
        (notWritten.length === 0
          ? ""
          : `\nNOT WRITTEN: ${notWritten.length} claim(s) starting with "#", which the file would read back as ` +
            "comments (listed in its header note). Bind each with `bind --claim <claim> --provider <id> --by <label>`: " +
            notWritten.map((row) => `"${escapeUnsafeDisplayChars(row.claim)}"`).join(", ")),
    };
  } finally {
    closeSync(fd);
    if (!written) unlinkSync(args.out);
    await prisma.$disconnect();
  }
}

/**
 * One bind-file line, in its own transaction: the row must still be the
 * unbound row of the line's tenant (CAS), the evidence recomputed now must
 * equal the line's, and the provider's users must be a majority — no
 * file-level override (`bind --accept-unused-provider` is the per-row path),
 * and a tenant with no active members is refused. A row already bound to the
 * line's provider reads as already bound, so a rerun is safe.
 */
async function applyBindLine(
  tx: TxClient,
  line: { claim: string; tenantId: string; provider: string; evidence: string },
  appEnv: AppEnv,
  by: string,
): Promise<BindLineOutcome> {
  const row = await tx.tenantClaim.findUnique({
    where: { claim: line.claim },
    select: { id: true, tenantId: true, revokedAt: true, provider: true },
  });
  if (row && row.tenantId === line.tenantId && row.revokedAt === null && row.provider === line.provider) {
    return BIND_LINE_OUTCOME.ALREADY_BOUND;
  }
  if (!row || row.tenantId !== line.tenantId || row.revokedAt !== null || row.provider !== null) {
    return BIND_LINE_OUTCOME.CAS_LOST;
  }
  const evidence = await readMemberEvidence(tx, row.tenantId, appEnv, null);
  if (formatEvidence(evidence) !== line.evidence) return BIND_LINE_OUTCOME.EVIDENCE_CHANGED;
  if (!isMajority(evidence.counts.get(line.provider) ?? 0, evidence.total)) {
    return BIND_LINE_OUTCOME.EVIDENCE_REFUSED;
  }
  return (await rebindInTx(tx, { ...row, claim: line.claim }, line.provider, by))
    ? BIND_LINE_OUTCOME.BOUND
    : BIND_LINE_OUTCOME.CAS_LOST;
}

/**
 * `bind --apply <file> --by <label>`: the second half. Validates the whole
 * file first and refuses it on any error; lines with an empty provider are not
 * applied. Prints a summary with the operator-chosen lines (provider differing
 * from the suggestion, or none was made) listed apart, asks once, then binds
 * line by line and prints a result per line. Exits non-zero when any line was
 * refused; the lines bound before it stay bound.
 */
export async function cmdBindApply(args: {
  file: string;
  by: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  const app = readAppEnv();
  if (!app.ok) return app.result;
  if (!app.env.present) return appEnvRequiredResult("bind --apply");
  const appEnv = app.env;

  let text: string;
  try {
    text = readFileSync(args.file, "utf8");
  } catch {
    return { ok: false, code: 1, message: `Cannot read bind file "${escapeUnsafeDisplayChars(args.file)}".` };
  }
  const parsed = parseBindFile(text, new Set(appEnv.claimProviders));
  if (!parsed.ok) {
    for (const error of parsed.errors) console.error(`  ${error}`);
    return {
      ok: false,
      code: 1,
      message: `Refusing the bind file: ${parsed.errors.length} error(s) above. Nothing was applied.`,
    };
  }

  const kept = parsed.lines.flatMap((line) => (line.provider === null ? [] : [{ ...line, provider: line.provider }]));
  const skipped = parsed.lines.length - kept.length;
  const chosen = kept.filter((line) => {
    const evidence = parseEvidence(line.evidence);
    return evidence === null || suggestedProvider(evidence) !== line.provider;
  });
  const suggestedLines = kept.filter((line) => !chosen.includes(line));
  const describe = (line: (typeof kept)[number]) =>
    `  line ${line.lineNo}: ${escapeUnsafeDisplayChars(line.claim)}\ttenant=${line.tenantId}\tprovider=${escapeUnsafeDisplayChars(line.provider)}\tmembers=${escapeUnsafeDisplayChars(line.evidence)}`;
  console.log(`Lines to bind as suggested (${suggestedLines.length}):`);
  suggestedLines.forEach((line) => console.log(describe(line)));
  console.log(
    `Operator-chosen lines — the provider differs from the suggestion, or there was none (${chosen.length}):`,
  );
  chosen.forEach((line) => console.log(describe(line)));
  console.log(`Lines left with an empty provider, not applied: ${skipped}.`);

  if (kept.length === 0) {
    return { ok: true, code: 0, rows: [], message: "No line names a provider; nothing to apply." };
  }
  const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
  if (!confirmed) {
    return { ok: false, code: 1, message: "Aborted: not confirmed." };
  }

  const prisma = migrationClientFactory.create(url);
  try {
    const results: Array<{ lineNo: number; claim: string; outcome: BindLineOutcome }> = [];
    for (const line of kept) {
      const outcome = await withBypassRls(
        prisma,
        (tx) => applyBindLine(tx, line, appEnv, args.by),
        BYPASS_GRANT.TENANT_CLAIM_BINDING_WRITE,
      );
      results.push({ lineNo: line.lineNo, claim: line.claim, outcome });
      console.log(`  line ${line.lineNo}\t${escapeUnsafeDisplayChars(line.claim)}\t${outcome}`);
    }
    const settled: readonly BindLineOutcome[] = [BIND_LINE_OUTCOME.BOUND, BIND_LINE_OUTCOME.ALREADY_BOUND];
    const refused = results.filter((r) => !settled.includes(r.outcome)).length;
    const bound = results.filter((r) => r.outcome === BIND_LINE_OUTCOME.BOUND).length;
    return {
      ok: refused === 0,
      code: refused === 0 ? 0 : 1,
      rows: results,
      message:
        `${bound} bound, ${results.length - bound - refused} already bound, ${refused} refused of ${results.length} line(s).` +
        (refused > 0
          ? " A refused line changed since the file was written: regenerate the file, or bind it with `bind --claim`."
          : ""),
    };
  } finally {
    await prisma.$disconnect();
  }
}

// ─── realign ─────────────────────────────────────────────────────

const REALIGN_WARNING = [
  "This moves the user's owning column onto the target tenant, and nothing else:",
  "their rows stay filed under the tenant they are filed under now (counted above),",
  "and their membership in the target tenant stays deactivated until that tenant",
  "reactivates it — through SCIM or directory sync, which it may do once it owns them.",
  "Both tenants receive a USER_TENANT_REALIGNED audit row with source \"operator\"",
  "and your --by label.",
].join("\n");

/**
 * Move a user's owning column onto a tenant where they already hold a membership
 * row — the one case no producer may resolve (round-7 F-R7-2).
 *
 * SCIM and directory sync reactivate a member only for a tenant that owns the
 * user (round-6 R6-S2), and the way back that leaves — signing in through the
 * tenant's IdP — exists only for a tenant with a tenant claim. A member who left
 * a claimless tenant, joined another and was suspended there is owned by that
 * other tenant for good. This command is the sanctioned, recorded exit.
 *
 * Refused:
 * - a user with an ACTIVE membership anywhere: that membership decides ownership,
 *   and moving the column away from it splits the two;
 * - a target where the user holds no membership row: the move follows an existing
 *   membership, it does not create one;
 * - an email matching more than one user (case variants): name the user by UUID.
 *
 * The move is `tenant-realignment-core.ts`'s, so the record is the application's:
 * USER_TENANT_REALIGNED on both tenants, the system as actor, source "operator",
 * and `--by` as `by`. Not atomic against a concurrent activation elsewhere between
 * the check and the write; an operator runs this once, deliberately.
 */
export async function cmdRealign(args: {
  user: string;
  tenant: string;
  by: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const tenant = await resolveTenantRef(tx, args.tenant);
        if (!tenant) {
          return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(args.tenant)}` };
        }
        if (tenant.id === SYSTEM_TENANT_ID) {
          return {
            ok: false,
            code: 1,
            message: "The target is the sentinel tenant, which encodes \"no owning tenant\" and must hold no accounts.",
          };
        }

        const select = { id: true, email: true, tenantId: true } as const;
        const users = UUID_RE.test(args.user)
          ? await tx.user.findMany({ where: { id: args.user }, select })
          : // `in`, not `equals`: with `mode: "insensitive"` Prisma compiles `equals` to an
            // unescaped ILIKE, so `_` and `%` in the typed address matched OTHER users, and
            // realign moved one of them (round-8 R8-S1). `in` compiles to
            // LOWER(email) IN (LOWER($1)), the comparison the application makes.
            await tx.user.findMany({ where: { email: { in: [args.user], mode: "insensitive" } }, select });
        if (users.length === 0) {
          return { ok: false, code: 1, message: `User not found: ${escapeUnsafeDisplayChars(args.user)}` };
        }
        if (users.length > 1) {
          return {
            ok: false,
            code: 1,
            message:
              `More than one user matches "${escapeUnsafeDisplayChars(args.user)}" (emails differing only in case). ` +
              "Name the user by UUID.",
          };
        }
        const [user] = users;

        const active = await tx.tenantMember.findMany({
          where: { userId: user.id, deactivatedAt: null },
          select: { tenantId: true },
        });
        if (active.length > 0) {
          return {
            ok: false,
            code: 1,
            message:
              `User ${user.id} has an active membership in tenant ${active.map((m) => m.tenantId).join(", ")}. ` +
              "realign is only for a user active in no tenant: an active membership decides who owns the user, " +
              "and moving the column away from it would split the two.",
          };
        }

        const member = await tx.tenantMember.findUnique({
          where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
          select: { id: true },
        });
        if (!member) {
          return {
            ok: false,
            code: 1,
            message:
              `User ${user.id} holds no membership row in tenant ${tenant.id}. ` +
              "realign follows an existing membership; it does not create one.",
          };
        }

        if (user.tenantId === tenant.id) {
          return {
            ok: true,
            code: 0,
            tenantId: tenant.id,
            message: `User ${user.id} is already filed under tenant ${tenant.id}; nothing to do.`,
          };
        }

        const leftBehind = await countStrandedRows(tx, user.id, user.tenantId);
        printTenantSummary(tenant, await activeMemberCount(tx, tenant.id), "Target tenant:");
        console.log(`User:            ${user.id} (${escapeUnsafeDisplayChars(user.email ?? "-")})`);
        console.log(`Filed under now: ${user.tenantId}`);
        console.log(`Rows that stay under it: ${JSON.stringify(leftBehind)}`);
        console.log(REALIGN_WARNING);
        const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
        if (!confirmed) {
          return { ok: false, code: 1, message: "Aborted: not confirmed." };
        }

        const previous = await realignToMembershipInTxWith(
          {
            logAuditInTx: (atx, tenantId, params) => enqueueAuditInTx(atx, tenantId, buildOutboxPayload(params)),
            realignOwningTenantColumn,
            countStrandedRows,
          },
          tx,
          {
            userId: user.id,
            memberId: member.id,
            tenantId: tenant.id,
            cause: {
              source: REALIGNMENT_SOURCE.OPERATOR,
              actorUserId: SYSTEM_ACTOR_ID,
              actorType: ACTOR_TYPE.SYSTEM,
              label: args.by,
            },
          },
        );
        return {
          ok: true,
          code: 0,
          tenantId: tenant.id,
          message:
            `Realigned user ${user.id} from tenant ${previous} to tenant ${tenant.id}. ` +
            "Their membership there is still deactivated; that tenant can now reactivate it.",
        };
      },
      BYPASS_GRANT.TENANT_REALIGN_MEMBERSHIP,
      confirmationTransaction.options(),
    );
  } catch (e) {
    const timedOut = confirmationTimeoutResult(e);
    if (timedOut) return timedOut;
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── measure ─────────────────────────────────────────────────────

/**
 * The three counts `docs/archive/review/audit-tenant-adjudicator-design.md`'s
 * "Measurements" section specifies, run here rather than left as SQL an
 * operator pastes by hand: read-only, no writes, no confirmation.
 *
 * Query (2) is printed FIRST, ahead of (1) — the divergence count that
 * motivates `backfill-owning-column` — because it is the one that blocks
 * `docs/archive/review/audit-tenant-adjudicator-design.md`'s Q11 partial
 * unique index (SC5) regardless of what an operator decides about the
 * backfill, and an operator who runs `measure` once should see it before
 * anything else.
 *
 * Each query's predicate is the design note's, verbatim; only the output cast
 * (`::int`, to keep every count a `number` rather than a driver-dependent
 * `bigint`) is added.
 */
export async function cmdMeasure(): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const [{ count: multiActiveRaw }] = await tx.$queryRawUnsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM (
             SELECT user_id FROM tenant_members WHERE deactivated_at IS NULL
             GROUP BY user_id HAVING count(*) > 1
           ) t`,
        );
        const [{ count: divergentRaw }] = await tx.$queryRawUnsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM users u
           JOIN LATERAL (
             SELECT tm.tenant_id, count(*) OVER () AS n
               FROM tenant_members tm
              WHERE tm.user_id = u.id AND tm.deactivated_at IS NULL
              ORDER BY tm.created_at ASC LIMIT 1
           ) m ON true
          WHERE m.n = 1 AND m.tenant_id <> u.tenant_id`,
        );
        const [{ count: zeroActiveRaw }] = await tx.$queryRawUnsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM users u
          WHERE NOT EXISTS (
            SELECT 1 FROM tenant_members tm
             WHERE tm.user_id = u.id AND tm.deactivated_at IS NULL
          )`,
        );

        const multiActive = Number(multiActiveRaw);
        const divergent = Number(divergentRaw);
        const zeroActive = Number(zeroActiveRaw);

        console.log("Owning-tenant measurements (docs/archive/review/audit-tenant-adjudicator-design.md):");
        console.log(`  (2) more than one active membership (blocks the Q11 partial unique index, SC5): ${multiActive}`);
        console.log(`  (1) divergent — column != the single active membership: ${divergent}`);
        console.log(`  (3) zero active memberships (the producer's precondition): ${zeroActive}`);

        return {
          ok: true,
          code: 0,
          rows: [{ multiActive, divergent, zeroActive }],
          message: `divergent=${divergent} multiActive=${multiActive} zeroActive=${zeroActive}`,
        };
      },
      BYPASS_GRANT.TENANT_DOMAIN_DIVERGENCE_READ,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── legacy-accounts ─────────────────────────────────────────────

/**
 * The upgrade check for the legacy multi-connection deployment (README, "SSO
 * tenant claim binding upgrade" → "Known lockout"): read-only, no writes, no
 * audit events. Pre-upgrade SAML users of every connection hold an account at
 * `saml-jackson`. If the legacy provider is still configured, the IdP behind
 * the one connection its client names can assert another connection's user's
 * `providerAccountId` and, with no claim, sign in as that user. Refused (code 1)
 * when the provider is configured and those accounts span more than one tenant
 * (`legacyAccountVerdict`); without a readable provider configuration it
 * refuses rather than pass, since "not configured" is then unknown.
 */
export async function cmdLegacyAccounts(): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const app = readAppEnv();
  if (!app.ok) return app.result;
  if (!app.env.present) {
    return {
      ok: false,
      code: 1,
      message:
        "legacy-accounts needs the app's environment: whether the result is safe depends on whether " +
        `${JACKSON_LEGACY_PROVIDER_ID} (AUTH_JACKSON_ID/SECRET) is configured, and no SSO provider is ` +
        "configured in this process. Run it with the app's .env loaded; it does not pass without it.",
    };
  }
  const legacyConfigured = app.env.claimProviders.includes(JACKSON_LEGACY_PROVIDER_ID);

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const accounts = await tx.account.findMany({
          where: { provider: JACKSON_LEGACY_PROVIDER_ID },
          select: { userId: true },
        });
        const userIds = [...new Set(accounts.map((a) => a.userId))];
        const memberships =
          userIds.length === 0
            ? []
            : await tx.tenantMember.findMany({
                where: { userId: { in: userIds }, deactivatedAt: null },
                select: { userId: true, tenantId: true },
              });
        const groups = groupLegacyAccounts(accounts, new Map(memberships.map((m) => [m.userId, m.tenantId])));
        const tenantIds = groups.flatMap((g) => (g.tenantId === null ? [] : [g.tenantId]));
        const tenants =
          tenantIds.length === 0
            ? []
            : await tx.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } });
        const nameOf = new Map(tenants.map((t) => [t.id, t.name]));

        console.log(`Accounts at ${JACKSON_LEGACY_PROVIDER_ID}, by the tenant of their user's active membership:`);
        if (groups.length === 0) console.log("  (none)");
        for (const group of groups) {
          const where =
            group.tenantId === null
              ? "tenant=-\t(no active tenant)"
              : `tenant=${group.tenantId}\tname=${escapeUnsafeDisplayChars(nameOf.get(group.tenantId) ?? "-")}`;
          console.log(`  ${where}\tusers=${group.users}\taccounts=${group.accounts}`);
        }
        console.log(
          `${JACKSON_LEGACY_PROVIDER_ID} is ${legacyConfigured ? "" : "not "}configured in this process ` +
            `(claim providers: ${app.env.claimProviders.join(", ")}).`,
        );

        const total = accounts.length;
        const verdict = legacyAccountVerdict(groups, legacyConfigured);
        const rows = groups;
        switch (verdict) {
          case LEGACY_ACCOUNT_VERDICT.NONE:
            return {
              ok: true,
              code: 0,
              rows,
              message: `No account records ${JACKSON_LEGACY_PROVIDER_ID}: the legacy provider resolves no pre-upgrade account.`,
            };
          case LEGACY_ACCOUNT_VERDICT.UNRESOLVED:
            return {
              ok: true,
              code: 0,
              rows,
              message:
                `${total} account(s) record ${JACKSON_LEGACY_PROVIDER_ID}, and it is not configured, so no client ` +
                "resolves them. Their users are refused with account_not_linked through their connection's own " +
                'provider until re-provisioned (README, "Known lockout").',
            };
          case LEGACY_ACCOUNT_VERDICT.ONE_GROUP:
            return {
              ok: true,
              code: 0,
              rows,
              message:
                `${total} account(s) record ${JACKSON_LEGACY_PROVIDER_ID}, all of one ` +
                `${groups[0]?.tenantId === null ? "group (users with no active tenant)" : "tenant"}. ` +
                "Check that AUTH_JACKSON_ID is that tenant's connection's own client.",
            };
          case LEGACY_ACCOUNT_VERDICT.SPANS:
            return {
              ok: false,
              code: 1,
              rows,
              message:
                `Refusing: ${total} account(s) at ${JACKSON_LEGACY_PROVIDER_ID} belong to the users of ${groups.length} ` +
                "tenants (users with no active tenant count as one), and the legacy provider is configured. The IdP " +
                "behind the connection AUTH_JACKSON_ID names can assert another tenant's user's account id and sign " +
                "in as them. Unset AUTH_JACKSON_ID and AUTH_JACKSON_SECRET, list every connection, that one included, " +
                'in AUTH_JACKSON_CONNECTIONS (README, "Known lockout"), and re-run this check.',
            };
        }
      },
      BYPASS_GRANT.TENANT_LEGACY_ACCOUNT_READ,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── backfill-owning-column ────────────────────────────────────────

/**
 * How many candidates one query page reads at a time (S-F8): the candidate
 * LIST is read in keyset pages ordered by `users.id` (unique), so a single
 * query never has to materialise more than this many rows, regardless of how
 * many divergent users the table holds.
 */
const BACKFILL_CANDIDATE_PAGE_SIZE = 200;

/** `--limit`'s default and ceiling, named rather than inline (round pattern, see HISTORY_ROW_CAP above). */
const DEFAULT_BACKFILL_LIMIT = 100;
const MAX_BACKFILL_LIMIT = 10_000;

export type BackfillCandidate = {
  userId: string;
  from: string;
  to: string;
  activeMembershipCount: number;
  multiActive: boolean;
};

export type CandidateRow = {
  user_id: string;
  column_tenant_id: string;
  target_tenant_id: string;
  active_count: number;
};

/**
 * Pure row -> candidate mapping, exported so `multiActive` can be pinned by a
 * unit test independently of a live database (same motivation as
 * `formatUnmappedMessage` above).
 *
 * `tenant_members_one_active_per_user` (`prisma/migrations/20260909120000_one_active_membership_per_user`,
 * #830 — design-note Q11 / SC5, already shipped) makes `active_count > 1`
 * structurally unrepresentable going forward: no fixture can drive it in a
 * real database anymore. The branch stays, for two reasons the index does not
 * remove: a row written before that migration ran (it fails loudly on
 * pre-existing duplicates, but does not retroactively scan for rows a restore
 * or an out-of-band write could still introduce), and `owningTenantOf` itself
 * is a general rule with no knowledge of this index — decided here on
 * whatever it is handed, unconditionally, the same way its own unit tests do.
 */
export function candidateFromRow(row: CandidateRow): BackfillCandidate {
  return {
    userId: row.user_id,
    from: row.column_tenant_id,
    to: row.target_tenant_id,
    activeMembershipCount: row.active_count,
    multiActive: row.active_count > 1,
  };
}

/**
 * The candidate list: users whose column diverges from `owningTenantOf`'s
 * answer, i.e. exactly the rows design-note query (1) would count if it were
 * not restricted to `m.n = 1` — this candidate list deliberately widens that
 * restriction to include multi-active users too (item 4: "the adjudicator
 * decides them"), flagged `multiActive` rather than excluded.
 *
 * The WHERE clause is the SQL form of `owningTenantOf(column, active) !=
 * column`: `m.tenant_id` is that same oldest-active membership (the LATERAL's
 * own `ORDER BY created_at ASC LIMIT 1`), so filtering on `m.tenant_id <>
 * u.tenant_id` in SQL and calling `owningTenantOf` in application code answer
 * identically — proven by construction, not merely believed, because both
 * reduce to "the single row this LATERAL selects". The per-user APPLY step
 * below still calls the real function on a fresh read, which is what actually
 * decides whether a write happens.
 */
// Exported so the total-order fix (D8) can be pinned by a unit test that
// spies the `tx` client, independently of a live database — same motivation
// as `candidateFromRow` above.
export async function listDivergentCandidates(tx: TxClient, limit: number): Promise<BackfillCandidate[]> {
  const candidates: BackfillCandidate[] = [];
  let cursor = NIL_UUID;
  for (;;) {
    const page = await tx.$queryRawUnsafe<CandidateRow[]>(
      `SELECT u.id::text AS user_id, u.tenant_id::text AS column_tenant_id,
              m.tenant_id::text AS target_tenant_id, m.active_count::int AS active_count
         FROM users u
         JOIN LATERAL (
           SELECT tm.tenant_id, count(*) OVER () AS active_count
             FROM tenant_members tm
            WHERE tm.user_id = u.id AND tm.deactivated_at IS NULL
            ORDER BY tm.created_at ASC, tm.id ASC
            LIMIT 1
         ) m ON true
        WHERE u.id > $1::uuid
          AND m.tenant_id <> u.tenant_id
        ORDER BY u.id ASC
        LIMIT $2::int`,
      cursor,
      BACKFILL_CANDIDATE_PAGE_SIZE,
    );
    for (const row of page) {
      candidates.push(candidateFromRow(row));
      if (candidates.length >= limit) return candidates;
    }
    if (page.length < BACKFILL_CANDIDATE_PAGE_SIZE) return candidates; // table exhausted
    cursor = page[page.length - 1].user_id;
  }
}

function printCandidates(candidates: BackfillCandidate[]): void {
  console.log(`${candidates.length} candidate(s):`);
  for (const c of candidates) {
    console.log(
      `  userId=${c.userId} from=${c.from} to=${c.to} activeMembershipCount=${c.activeMembershipCount}` +
        (c.multiActive ? " multiActive" : ""),
    );
  }
}

type BackfillOutcome = { userId: string; moved: boolean; from?: string; to?: string; reason?: string };

/**
 * Move ONE user, inside its own bypass transaction: re-reads the column and
 * active memberships (never trusts the candidate list's snapshot), recomputes
 * the target with the real `owningTenantOf`, and skips rather than writes if
 * the user is no longer divergent — a membership deactivated between listing
 * and apply is exactly the case this re-check exists for (A-C4-2).
 *
 * Goes through `realignToMembershipInTxWith`, never a direct
 * `tx.user.update`/`updateMany` here, so the move is recorded the same way
 * `realign` records one (forbidden-pattern rule, C4 plan).
 */
// Exported for the same reason as listDivergentCandidates above (D8 pin).
export async function applyOneCandidate(tx: TxClient, userId: string, by: string): Promise<BackfillOutcome> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      tenantId: true,
      tenantMemberships: {
        where: { deactivatedAt: null },
        select: { id: true, tenantId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!user) {
    return { userId, moved: false, reason: "user no longer exists" };
  }

  const active = user.tenantMemberships;
  const target = owningTenantOf(user.tenantId, active);
  if (target === user.tenantId) {
    return { userId, moved: false, reason: "no longer divergent" };
  }

  // `target` came out of `active`, so this is always found — defensive rather
  // than assumed, because the two reads above are not atomic with each other
  // beyond sharing this transaction's snapshot.
  const member = active.find((m) => m.tenantId === target);
  if (!member) {
    return { userId, moved: false, reason: "target membership row no longer active" };
  }

  const previous = await realignToMembershipInTxWith(
    {
      logAuditInTx: (atx, tenantId, params) => enqueueAuditInTx(atx, tenantId, buildOutboxPayload(params)),
      realignOwningTenantColumn,
      countStrandedRows,
    },
    tx,
    {
      userId,
      memberId: member.id,
      tenantId: target,
      cause: {
        source: REALIGNMENT_SOURCE.OPERATOR,
        actorUserId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        label: by,
      },
    },
  );
  if (previous === null) {
    // realignToMembershipInTxWith's own no-op case: the column already named
    // `target` by the time this transaction's write ran.
    return { userId, moved: false, reason: "no longer divergent" };
  }
  return { userId, moved: true, from: previous, to: target };
}

/**
 * List, then optionally apply, the owning-column backfill (C4/#838): users
 * whose `User.tenantId` diverges from `owningTenantOf`'s answer over their
 * active memberships — the class `docs/archive/review/audit-tenant-adjudicator-design.md`
 * measures and defers fixing at the row level, because `resolveOwningTenantIdFromClient`
 * already reads through the adjudicator, so the rows read correctly today; the
 * column is what this closes.
 *
 * Fail-closed shape, same family as `add`/`remove`/`realign`:
 * - `--by` is validated BEFORE the client is built (S-F3), so an invalid
 *   label never reaches even the read-only listing;
 * - no `--apply` is the DEFAULT: this lists candidates and exits 0 with zero
 *   writes, always — an operator who forgets the flag gets a report, not a
 *   migration;
 * - `--apply` still requires confirmation (or `--yes`) AFTER the same list
 *   has been printed, so what is confirmed is what was shown;
 * - each user moves in its OWN transaction (`applyOneCandidate` above), so a
 *   user divergent at listing time but fixed by another process before apply
 *   reads as "no longer divergent" rather than being moved on stale data.
 */
export async function cmdBackfillOwningColumn(args: {
  by: string;
  apply?: boolean;
  yes?: boolean;
  limit?: number;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

  const limit = args.limit ?? DEFAULT_BACKFILL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BACKFILL_LIMIT) {
    return {
      ok: false,
      code: 1,
      // operator-echo-exempt: `limit` is a number here, not operator text — the
      // CLI wrapper refuses anything that does not match /^\d+$/ and escapes it
      // there, so what reaches this arm is a parsed value (NaN included).
      message: `Invalid --limit "${limit}": expected an integer between 1 and ${MAX_BACKFILL_LIMIT}.`,
    };
  }

  const prisma = migrationClientFactory.create(url);
  try {
    const candidates = await withBypassRls(
      prisma,
      (tx) => listDivergentCandidates(tx, limit),
      BYPASS_GRANT.TENANT_DOMAIN_DIVERGENCE_READ,
    );

    printCandidates(candidates);

    if (!args.apply) {
      return {
        ok: true,
        code: 0,
        rows: candidates,
        message: `${candidates.length} candidate(s) listed. Dry run — no writes made. Re-run with --apply to move them.`,
      };
    }

    if (candidates.length === 0) {
      return { ok: true, code: 0, rows: [], message: "No divergent users found; nothing to apply." };
    }

    console.log(
      `This will move the owning-tenant column for up to ${candidates.length} user(s), ` +
        'each recorded as a USER_TENANT_REALIGNED audit row with source "operator" on both tenants.',
    );
    const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
    if (!confirmed) {
      return { ok: false, code: 1, message: "Aborted: not confirmed." };
    }

    const outcomes: BackfillOutcome[] = [];
    for (const candidate of candidates) {
      const outcome = await withBypassRls(
        prisma,
        (tx) => applyOneCandidate(tx, candidate.userId, args.by),
        BYPASS_GRANT.TENANT_DOMAIN_BACKFILL_APPLY,
      );
      outcomes.push(outcome);
      console.log(
        outcome.moved
          ? `  userId=${outcome.userId} realigned from=${outcome.from} to=${outcome.to}`
          : `  userId=${outcome.userId} skipped (${outcome.reason})`,
      );
    }
    const moved = outcomes.filter((o) => o.moved).length;
    return {
      ok: true,
      code: 0,
      rows: outcomes,
      message: `${moved} of ${candidates.length} candidate(s) realigned.`,
    };
  } finally {
    await prisma.$disconnect();
  }
}

// ─── CLI wrapper ─────────────────────────────────────────────────

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  tenant-domain list    [--tenant <ref>] [--unbound]",
      `  tenant-domain unmapped [--days <n>]           (default ${DEFAULT_UNMAPPED_WINDOW_DAYS})`,
      "  tenant-domain add     --tenant <ref> --domain <domain> --by <label> (--provider <id> | --unbound)",
      "                        [--from <current-owner-uuid>] [--accept-unused-provider] [--yes]",
      "  tenant-domain bind    --claim <claim> --provider <id> --by <label> [--accept-unused-provider] [--yes]",
      "  tenant-domain bind    --from-members --out <file>",
      "  tenant-domain bind    --apply <file> --by <label> [--yes]",
      "  tenant-domain remove  --tenant <ref> --domain <domain> --by <label> [--yes]",
      "  tenant-domain history --domain <claim> | --tenant <uuid> [--after <seq>]",
      "  tenant-domain realign --user <uuid|email> --tenant <ref> --by <label> [--yes]",
      "  tenant-domain measure",
      "  tenant-domain legacy-accounts",
      `  tenant-domain backfill-owning-column --by <label> [--apply] [--yes] [--limit <n>]  (default ${DEFAULT_BACKFILL_LIMIT}, max ${MAX_BACKFILL_LIMIT})`,
      "",
      "<ref> is a tenant UUID or one of its registered claims (not its slug).",
      "--from moves a claim off the tenant that currently owns it; it takes that tenant's",
      "UUID only, and `add` refuses if it does not match the row's actual owner.",
      "realign moves a user active in no tenant onto a tenant where they hold a",
      "membership row, for the member SCIM and directory sync may not take back.",
      "It refuses the sentinel tenant as the target, and an email that matches more",
      "than one user (case variants of one address; name the user by UUID).",
      "--provider is the full SSO provider id a claim is bound to (google, saml-jackson,",
      "saml-jackson-<connection id>). In strict binding mode add requires it; otherwise",
      "add needs --provider or an explicit --unbound. add and bind refuse a provider whose",
      "users are not a majority of the tenant's active members unless --accept-unused-provider.",
      "bind --from-members writes a review file of every unbound claim (outside the git",
      "worktree, never overwriting); bind --apply binds the lines whose provider you kept.",
      "Both need the app's SSO provider env. list --unbound lists the claims strict refuses.",
      "add, remove, bind and realign ask for confirmation inside their transaction:",
      `answer within ${confirmationBudgetText()}, or re-run the command. Do not leave a prompt`,
      "open while migrations deploy: its reads hold table locks a migration waits for,",
      "and sign-ins queue behind that migration.",
      "",
      "measure prints the three docs/archive/review/audit-tenant-adjudicator-design.md",
      "counts (divergent column, multi-active-membership users, zero-active users);",
      "read-only. backfill-owning-column lists (default) or, with --apply, moves the",
      "divergent users measure counts, each through the same adjudicator realign uses:",
      "the oldest active membership wins over the column, and a multi-active user is",
      "decided, not refused, and flagged multiActive in the listing.",
      "",
      "legacy-accounts counts the accounts at saml-jackson by their users' active tenant,",
      "read-only, and exits non-zero when saml-jackson is configured and they span more",
      "than one tenant (users with no active tenant count as one). Needs the app's SSO env.",
      "",
      "MIGRATION_DATABASE_URL must be set to a privileged connection string.",
      "Example: MIGRATION_DATABASE_URL=postgresql://... npm run tenant-domain -- add --tenant acmecorp --domain alias.example --by ops-oncall",
    ].join("\n"),
  );
}

/**
 * `bind`'s three forms, told apart by which of `--claim`, `--from-members` and
 * `--apply` is given — exactly one. A flag the chosen form does not read stops
 * the command rather than being dropped (the flags module's rule). Null means
 * print the usage.
 */
async function dispatchBind(flags: ParsedFlags, yes: boolean): Promise<CmdResult | null> {
  const claim = getStringFlag(flags, "claim");
  const applyFile = getStringFlag(flags, "apply");
  const fromMembers = flags.get("from-members") === true;
  if ([claim !== undefined, applyFile !== undefined, fromMembers].filter(Boolean).length !== 1) return null;

  const accepted = fromMembers
    ? ["from-members", "out"]
    : applyFile !== undefined
      ? ["apply", "by", "yes"]
      : ["claim", "provider", "by", "accept-unused-provider", "yes"];
  const stray = [...flags.keys()].filter((name) => !accepted.includes(name));
  if (stray.length > 0) {
    return {
      ok: false,
      code: 1,
      message:
        `This form of bind does not read ${stray.map((name) => `--${escapeUnsafeDisplayChars(name)}`).join(", ")}. ` +
        "Refusing rather than ignoring it: a flag the operator wrote must either take effect or stop the command.",
    };
  }

  if (fromMembers) {
    const out = getStringFlag(flags, "out");
    return out ? cmdBindFromMembers({ out }) : null;
  }
  const by = getStringFlag(flags, "by");
  if (!by) return null;
  if (applyFile !== undefined) return cmdBindApply({ file: applyFile, by, yes });
  const provider = getStringFlag(flags, "provider");
  if (!claim || !provider) return null;
  return cmdBind({
    claim,
    provider,
    by,
    acceptUnusedProvider: flags.get("accept-unused-provider") === true,
    yes,
  });
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const parsed = parseFlags(rest, subcommand);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const flags = parsed.flags;
  const yes = flags.get("yes") === true;

  // Stray flags first: `remove --provider` is a flag remove never reads, and
  // "requires a value" would send the operator to supply one.
  const stray = findStrayFlags(flags, subcommand);
  if (subcommand !== undefined && stray.length > 0) {
    console.error(strayFlagsError(stray, subcommand));
    process.exitCode = 1;
    return;
  }

  const valueless = findValuelessFlag(flags, subcommand);
  if (valueless) {
    console.error(valuelessError(valueless, subcommand));
    process.exitCode = 1;
    return;
  }

  let result: CmdResult;
  switch (subcommand) {
    case "list":
      result = await cmdList({ tenant: getStringFlag(flags, "tenant"), unbound: flags.get("unbound") === true });
      break;
    case "unmapped": {
      const rawDays = getStringFlag(flags, "days");
      if (rawDays !== undefined && !/^\d+$/.test(rawDays)) {
        // Escaped: this is the arm for a value that did NOT match /^\d+$/, i.e.
        // arbitrary operator text, printed before anything has validated it
        // (round-6 F4 — the sixth site of the class round 5 declared closed).
        console.error(
          `Invalid --days "${escapeUnsafeDisplayChars(rawDays)}": expected a positive integer number of days.`,
        );
        process.exitCode = 1;
        return;
      }
      result = await cmdUnmapped(rawDays === undefined ? {} : { days: Number(rawDays) });
      break;
    }
    case "add": {
      const tenant = getStringFlag(flags, "tenant");
      const domain = getStringFlag(flags, "domain");
      const by = getStringFlag(flags, "by");
      // A valueless `--from` (e.g. `--from --yes`) must not silently degrade
      // into "no reassignment requested" — that would turn an intended move
      // into the wrong-owner refusal, or worse, read as a plain add. Handled by
      // findValuelessFlag above, together with every other value-taking flag.
      const from = getStringFlag(flags, "from");
      if (!tenant || !domain || !by) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = await cmdAdd({
        tenant,
        domain,
        by,
        from,
        provider: getStringFlag(flags, "provider"),
        unbound: flags.get("unbound") === true,
        acceptUnusedProvider: flags.get("accept-unused-provider") === true,
        yes,
      });
      break;
    }
    case "bind": {
      const bindResult = await dispatchBind(flags, yes);
      if (bindResult === null) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = bindResult;
      break;
    }
    case "remove": {
      const tenant = getStringFlag(flags, "tenant");
      const domain = getStringFlag(flags, "domain");
      const by = getStringFlag(flags, "by");
      if (!tenant || !domain || !by) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = await cmdRemove({ tenant, domain, by, yes });
      break;
    }
    case "history": {
      result = await cmdHistory({
        domain: getStringFlag(flags, "domain"),
        tenant: getStringFlag(flags, "tenant"),
        after: getStringFlag(flags, "after"),
      });
      break;
    }
    case "realign": {
      const user = getStringFlag(flags, "user");
      const tenant = getStringFlag(flags, "tenant");
      const by = getStringFlag(flags, "by");
      if (!user || !tenant || !by) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = await cmdRealign({ user, tenant, by, yes });
      break;
    }
    case "measure":
      result = await cmdMeasure();
      break;
    case "legacy-accounts":
      result = await cmdLegacyAccounts();
      break;
    case "backfill-owning-column": {
      const by = getStringFlag(flags, "by");
      if (!by) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const rawLimit = getStringFlag(flags, "limit");
      if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
        // Escaped: arbitrary operator text that did not match /^\d+$/, printed
        // before anything has validated it (same convention as `unmapped`'s
        // --days, round-6 F4).
        console.error(
          `Invalid --limit "${escapeUnsafeDisplayChars(rawLimit)}": expected a positive integer.`,
        );
        process.exitCode = 1;
        return;
      }
      const apply = flags.get("apply") === true;
      result = await cmdBackfillOwningColumn({
        by,
        apply,
        yes,
        limit: rawLimit === undefined ? undefined : Number(rawLimit),
      });
      break;
    }
    default:
      printUsage();
      process.exitCode = subcommand ? 1 : 0;
      return;
  }

  if (result.message) {
    if (result.ok) console.log(result.message);
    else console.error(result.message);
  }
  process.exitCode = result.code;
}

// Run only when invoked as a CLI, so the integration test can import the
// command functions without the module connecting to a DB on import
// (bootstrap-rds-roles.mjs's shape — round-3 M26).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerBypassNoticeSink(stderrBypassNoticeSink);
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
