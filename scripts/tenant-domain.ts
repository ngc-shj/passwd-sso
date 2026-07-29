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
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- list [--tenant <uuid|domain>]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- preflight
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add    --tenant <uuid|domain> --domain <domain> --by <label> [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove --tenant <uuid|domain> --domain <domain> [--yes]
//
// `--tenant` accepts either the tenant's UUID or one of its already-
// registered claims (normalised the same way `add`/`remove` normalise
// `--domain`). `--by` is a self-asserted operator label (NOT authenticated
// attribution — there is no application user identity on this connection,
// see SC8) stored verbatim in TenantClaim.createdBy.

import { loadEnv } from "@/lib/load-env";
loadEnv();

import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pathToFileURL } from "node:url";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  normalizeTenantClaim,
  storableClaimSchema,
  operatorDomainSchema,
  NON_PRINTABLE_ASCII_SQL_CLASS,
} from "@/lib/tenant/tenant-claim-registry";
import { UUID_RE } from "@/lib/constants/app";
import { AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { createPrompter } from "./lib/prompt";

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
function createMigrationClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// `--tenant` resolution: a literal UUID names the tenant directly; anything
// else is treated as one of the tenant's already-registered claims
// (normalised the same way `--domain` is). Revoked claims still resolve a
// tenant reference here — the row still occupies its slot in UNIQUE(claim)
// and identifying "which tenant used to own this" is a legitimate operator
// need (e.g. re-registering the same domain to the same tenant after a
// mistaken `remove`).
async function resolveTenantRef(
  tx: TxClient,
  ref: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  if (UUID_RE.test(ref)) {
    return tx.tenant.findUnique({
      where: { id: ref },
      select: { id: true, name: true, slug: true },
    });
  }
  const claim = normalizeTenantClaim(ref);
  const row = await tx.tenantClaim.findUnique({
    where: { claim },
    select: { tenantId: true },
  });
  if (!row) return null;
  return tx.tenant.findUnique({
    where: { id: row.tenantId },
    select: { id: true, name: true, slug: true },
  });
}

async function activeMemberCount(tx: TxClient, tenantId: string): Promise<number> {
  return tx.tenantMember.count({ where: { tenantId, deactivatedAt: null } });
}

function printTenantSummary(
  tenant: { id: string; name: string; slug: string },
  activeMembers: number,
): void {
  console.log("Tenant:");
  console.log(`  id:             ${tenant.id}`);
  console.log(`  name:           ${tenant.name}`);
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

// ─── list ────────────────────────────────────────────────────────

export async function cmdList(args: { tenant?: string }): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = createMigrationClient(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        let tenantId: string | undefined;
        if (args.tenant) {
          const tenant = await resolveTenantRef(tx, args.tenant);
          if (!tenant) {
            return { ok: false, code: 1, message: `Tenant not found: ${args.tenant}` };
          }
          tenantId = tenant.id;
        }

        const rows = await tx.tenantClaim.findMany({
          where: tenantId ? { tenantId } : undefined,
          select: { claim: true, tenantId: true, createdBy: true, createdAt: true, revokedAt: true },
          orderBy: { claim: "asc" },
        });

        // Printed verbatim (post C6-sanitizer strip) — there is no
        // punycode/IDN canonicalisation in this PR (C2), so there is
        // nothing to render beyond the stored string.
        for (const row of rows) {
          const status = row.revokedAt ? `revoked ${row.revokedAt.toISOString()}` : "active";
          console.log(
            `${row.claim}\ttenant=${row.tenantId}\tcreatedBy=${row.createdBy ?? "-"}\tcreatedAt=${row.createdAt.toISOString()}\t${status}`,
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
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── unmapped ────────────────────────────────────────────────────

type UnmappedRow = { tenant_id: string; claim: string; cnt: bigint | number; last_seen: Date };

// Pure — exported so a test can pin the S12 "empty is not the same as
// silent" wording without depending on the shared dev DB happening to have
// zero real tenant_claim_unmapped denials at test time (other working
// copies on this same feature branch may be exercising sign-in concurrently).
export function formatUnmappedMessage(rows: UnmappedRow[]): string {
  if (rows.length === 0) {
    return (
      `No unmapped-claim denials in the retained window (last ${AUDIT_LOG_RETENTION_MIN} days). ` +
      "This means either nothing is unmapped, or the denial fell outside the window — " +
      "it does NOT necessarily mean nothing was denied."
    );
  }
  return `${rows.length} unmapped-claim denial group(s) in the last ${AUDIT_LOG_RETENTION_MIN} days.`;
}

export async function cmdUnmapped(): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = createMigrationClient(url);
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
        const rows = await tx.$queryRawUnsafe<UnmappedRow[]>(
          `SELECT tenant_id::text AS tenant_id, claim, count(*)::int AS cnt, max(created_at) AS last_seen
             FROM (
               SELECT tenant_id, metadata->>'claim' AS claim, created_at
                 FROM audit_logs
                WHERE action = 'AUTH_LOGIN_FAILURE'::"AuditAction"
                  AND metadata->>'reason' = 'tenant_claim_unmapped'
                  AND created_at >= now() - make_interval(days => $1::int)
               UNION ALL
               SELECT tenant_id, payload->'metadata'->>'claim' AS claim, created_at
                 FROM audit_outbox
                WHERE status = 'PENDING'::"AuditOutboxStatus"
                  AND payload->>'action' = 'AUTH_LOGIN_FAILURE'
                  AND payload->'metadata'->>'reason' = 'tenant_claim_unmapped'
                  AND created_at >= now() - make_interval(days => $1::int)
             ) combined
            WHERE claim IS NOT NULL
            GROUP BY tenant_id, claim
            ORDER BY last_seen DESC`,
          AUDIT_LOG_RETENTION_MIN,
        );

        for (const row of rows) {
          console.log(
            `  tenant=${row.tenant_id}  claim="${row.claim}"  count=${Number(row.cnt)}  lastSeen=${new Date(row.last_seen).toISOString()}`,
          );
        }

        // S12: an empty result says so explicitly, with the window it
        // checked, rather than rendering as an indistinguishable empty list
        // — printed via `message` (not console.log here) so both the CLI
        // wrapper AND the integration test observe the identical text,
        // without depending on the shared dev DB happening to be globally
        // empty of unmapped-claim denials at test time.
        const message = formatUnmappedMessage(rows);

        return { ok: true, code: 0, rows, message };
      },
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── preflight ───────────────────────────────────────────────────

type CollisionRow = { normalized_claim: string; tenant_ids: string[]; collision_count: bigint | number };
type NonAsciiRow = { id: string; external_id: string };
type RawExternalIdRow = { id: string; external_id: string; pg_fold: string };

export async function cmdPreflight(): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = createMigrationClient(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        // Query 1 — normalisation collisions: tenants whose RAW external_id
        // folds (lower(btrim(x) COLLATE "C"), matching the CHECK/backfill —
        // round-5 D3) to the same claim as another tenant's. These are what
        // the backfill's ON CONFLICT DO NOTHING silently skips.
        const collisions = await tx.$queryRawUnsafe<CollisionRow[]>(
          `SELECT lower(btrim(external_id) COLLATE "C") AS normalized_claim,
                  array_agg(id ORDER BY id) AS tenant_ids,
                  count(*)::int AS collision_count
             FROM tenants
            WHERE external_id IS NOT NULL
              AND btrim(external_id) <> ''
              AND external_id !~ $1
            GROUP BY 1
           HAVING count(*) > 1
            ORDER BY 1`,
          NON_PRINTABLE_ASCII_SQL_CLASS,
        );

        // Query 2 — non-ASCII RAW external_id values the backfill excludes
        // entirely (SC9's narrowing made visible before the upgrade runs).
        const nonAscii = await tx.$queryRawUnsafe<NonAsciiRow[]>(
          `SELECT id, external_id
             FROM tenants
            WHERE external_id IS NOT NULL
              AND btrim(external_id) <> ''
              AND external_id ~ $1
            ORDER BY id`,
          NON_PRINTABLE_ASCII_SQL_CLASS,
        );

        // Query 3 (round-5 D3) — rows where the Postgres fold and the JS
        // fold of the SAME raw external_id disagree. Only Postgres's half
        // can run in SQL; the JS half runs here against the real
        // normalizeTenantClaim (never reimplemented) and the two are
        // compared in application code.
        const allExternalIds = await tx.$queryRawUnsafe<RawExternalIdRow[]>(
          `SELECT id, external_id, lower(btrim(external_id) COLLATE "C") AS pg_fold
             FROM tenants
            WHERE external_id IS NOT NULL
              AND btrim(external_id) <> ''`,
        );
        const foldMismatches = allExternalIds
          .filter((r) => r.pg_fold !== normalizeTenantClaim(r.external_id))
          .map((r) => ({
            id: r.id,
            externalId: r.external_id,
            pgFold: r.pg_fold,
            jsFold: normalizeTenantClaim(r.external_id),
          }));

        console.log("Pre-upgrade checks (C12):");
        console.log(`  normalisation collisions: ${collisions.length}`);
        for (const c of collisions) {
          console.log(`    claim="${c.normalized_claim}" tenants=${c.tenant_ids.join(",")} count=${Number(c.collision_count)}`);
        }
        console.log(`  non-ASCII external_id (excluded by backfill): ${nonAscii.length}`);
        for (const n of nonAscii) {
          console.log(`    tenant=${n.id} external_id="${n.external_id}"`);
        }
        console.log(`  Postgres/JS fold mismatches: ${foldMismatches.length}`);
        for (const m of foldMismatches) {
          console.log(`    tenant=${m.id} external_id="${m.externalId}" pgFold="${m.pgFold}" jsFold="${m.jsFold}"`);
        }

        const message = `${collisions.length} collision(s), ${nonAscii.length} non-ASCII, ${foldMismatches.length} fold mismatch(es).`;
        return { ok: true, code: 0, rows: [...collisions, ...nonAscii, ...foldMismatches], message };
      },
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── add ─────────────────────────────────────────────────────────

const ROW_6_9A_WARNING = [
  "Registering this claim does not only decide which NEW users land in this tenant:",
  "if any EXISTING bootstrap-tenant user's next sign-in presents this exact claim,",
  "their ENTIRE personal estate (password entries, vault key, attachments,",
  "emergency-access grants, shares, API keys, WebAuthn credentials, sessions,",
  "and audit history) is reassigned into this tenant on that sign-in.",
].join("\n");

export async function cmdAdd(args: {
  tenant: string;
  domain: string;
  by: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  if (!args.by || args.by.trim().length === 0) {
    return { ok: false, code: 1, message: "--by is required (a self-asserted operator label)." };
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
      message: `Invalid --domain "${args.domain}": ${parsed.error.issues[0]?.message ?? "does not satisfy operatorDomainSchema"} (example: alias.example)`,
    };
  }
  const claim = parsed.data;

  const prisma = createMigrationClient(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const tenant = await resolveTenantRef(tx, args.tenant);
        if (!tenant) {
          return { ok: false, code: 1, message: `Tenant not found: ${args.tenant}` };
        }

        // The ONE tenantClaim.findUnique call site outside
        // tenant-management.ts's resolver (C3/C4): this command's D2
        // semantics need the owning tenant AND the revoked state, which
        // resolveTenantByClaim deliberately does not expose (it filters
        // revoked rows to null so sign-in cannot resurrect them silently).
        const existing = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true },
        });

        // D2: a row owned by a DIFFERENT tenant is always a refusal,
        // revoked or not — re-registering someone else's claim is a
        // deliberate operator act on THAT row, not something `add` decides
        // unilaterally by naming a different tenant.
        if (existing && existing.tenantId !== tenant.id) {
          const state = existing.revokedAt ? "revoked and owned by" : "owned by";
          return {
            ok: false,
            code: 1,
            message: `Claim "${claim}" is ${state} tenant ${existing.tenantId}, not ${tenant.id}. Refusing to reassign — run "remove" on the owning tenant first if this is intentional.`,
          };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);

        // D2 idempotency (VE2): already owned by this tenant and not
        // revoked — success, no write, no confirmation prompt (nothing is
        // about to mutate).
        if (existing && existing.revokedAt === null) {
          printTenantSummary(tenant, activeMembers);
          console.log(`Claim "${claim}" is already registered to this tenant. No change made.`);
          return { ok: true, code: 0, tenantId: tenant.id, claim, message: "already registered (idempotent)" };
        }

        printTenantSummary(tenant, activeMembers);
        console.log("Target claim row:");
        console.log(`  claim: ${claim}`);
        console.log(
          existing
            ? `  status: REVOKED at ${existing.revokedAt!.toISOString()} — this add will CLEAR revokedAt (D2 recovery)`
            : "  status: NEW — no existing row",
        );
        console.log("");
        console.log(ROW_6_9A_WARNING);

        const confirmed = args.yes === true ? true : await (args.confirm ?? defaultConfirm)("Proceed?");
        if (!confirmed) {
          return { ok: false, code: 1, message: "Aborted: not confirmed." };
        }

        if (existing) {
          await tx.tenantClaim.update({
            where: { id: existing.id },
            data: { revokedAt: null, createdBy: args.by },
          });
        } else {
          try {
            await tx.tenantClaim.create({ data: { tenantId: tenant.id, claim, createdBy: args.by } });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
              return {
                ok: false,
                code: 1,
                message: `Claim "${claim}" was registered concurrently by another process. Re-run "list" to see its current owner.`,
              };
            }
            throw e;
          }
        }

        console.log(
          existing
            ? `Un-revoked claim "${claim}" for tenant ${tenant.id}.`
            : `Registered claim "${claim}" for tenant ${tenant.id}.`,
        );
        console.log(
          "Reminder: if this deployment sets GOOGLE_WORKSPACE_DOMAINS, src/auth.config.ts's " +
            "signIn callback (:207-215) denies any Google sign-in whose `hd` is not in that list " +
            "BEFORE tenant resolution runs. Registering this claim alone changes nothing for such " +
            "a deployment, and \"unmapped\" will keep showing nothing for it, until the domain is " +
            "also added to GOOGLE_WORKSPACE_DOMAINS.",
        );

        return { ok: true, code: 0, tenantId: tenant.id, claim };
      },
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── remove ──────────────────────────────────────────────────────

export async function cmdRemove(args: {
  tenant: string;
  domain: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

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
      message: `Invalid --domain "${args.domain}": ${parsed.error.issues[0]?.message ?? "does not satisfy storableClaimSchema"}`,
    };
  }
  const claim = parsed.data;

  const prisma = createMigrationClient(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        const tenant = await resolveTenantRef(tx, args.tenant);
        if (!tenant) {
          return { ok: false, code: 1, message: `Tenant not found: ${args.tenant}` };
        }

        const existing = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true, createdAt: true },
        });
        if (!existing) {
          return { ok: false, code: 1, message: `No claim "${claim}" is registered to any tenant.` };
        }

        // Round-2 S4: `claim` is globally unique, so without this check
        // `remove --domain <typo>` would reach into ANY tenant and deny
        // every one of its members at their next sign-in.
        if (existing.tenantId !== tenant.id) {
          return {
            ok: false,
            code: 1,
            message: `Claim "${claim}" is owned by tenant ${existing.tenantId}, not ${tenant.id}. Refusing to remove.`,
          };
        }

        if (existing.revokedAt !== null) {
          console.log(`Claim "${claim}" is already revoked (since ${existing.revokedAt.toISOString()}). No change made.`);
          return { ok: true, code: 0, tenantId: tenant.id, claim, message: "already revoked (idempotent)" };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);
        printTenantSummary(tenant, activeMembers);
        console.log("Target claim row:");
        console.log(`  claim:     ${claim}`);
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
        const result = await tx.tenantClaim.updateMany({
          where: { claim, tenantId: tenant.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (result.count === 0) {
          return {
            ok: false,
            code: 1,
            message: `Claim "${claim}" was modified concurrently by another process. Re-run "list" to see its current state.`,
          };
        }

        console.log(`Revoked claim "${claim}" for tenant ${tenant.id}.`);
        return { ok: true, code: 0, tenantId: tenant.id, claim };
      },
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── CLI wrapper ─────────────────────────────────────────────────

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function getStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  tenant-domain list [--tenant <uuid|domain>]",
      "  tenant-domain unmapped",
      "  tenant-domain preflight",
      "  tenant-domain add    --tenant <uuid|domain> --domain <domain> --by <label> [--yes]",
      "  tenant-domain remove --tenant <uuid|domain> --domain <domain> [--yes]",
      "",
      "MIGRATION_DATABASE_URL must be set to a privileged connection string.",
      "Example: MIGRATION_DATABASE_URL=postgresql://... npm run tenant-domain -- add --tenant acmecorp --domain alias.example --by ops-oncall",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const yes = flags.get("yes") === true;

  let result: CmdResult;
  switch (subcommand) {
    case "list":
      result = await cmdList({ tenant: getStringFlag(flags, "tenant") });
      break;
    case "unmapped":
      result = await cmdUnmapped();
      break;
    case "preflight":
      result = await cmdPreflight();
      break;
    case "add": {
      const tenant = getStringFlag(flags, "tenant");
      const domain = getStringFlag(flags, "domain");
      const by = getStringFlag(flags, "by");
      if (!tenant || !domain || !by) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = await cmdAdd({ tenant, domain, by, yes });
      break;
    }
    case "remove": {
      const tenant = getStringFlag(flags, "tenant");
      const domain = getStringFlag(flags, "domain");
      if (!tenant || !domain) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      result = await cmdRemove({ tenant, domain, yes });
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
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
