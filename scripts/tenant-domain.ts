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
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- list [--tenant <ref>]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped [--days <n>]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- preflight
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add    --tenant <ref> --domain <domain> --by <label> [--from <current-owner-uuid>] [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove --tenant <ref> --domain <domain> [--yes]
//
// `--tenant <ref>` accepts the tenant's UUID, one of its already-registered
// claims (normalised the same way `add`/`remove` normalise `--domain`), or its
// `tenants.external_id`. The last matters at incident time: a tenant whose
// backfill row `preflight` reports as skipped has NO claim row, and would
// otherwise be nameable only by UUID. `tenants.slug` is NOT accepted — see
// resolveTenantRef for why (round-2 F-F).
//
// `--by` is a self-asserted operator label (NOT authenticated attribution —
// there is no application user identity on this connection, see SC8) stored
// verbatim in TenantClaim.createdBy when a row is CREATED. It is deliberately
// not written on the un-revoke or reassign paths, which preserve the original
// registrant — see cmdAdd.
//
// `--from` is `add`'s reassignment flag: it names the tenant that currently
// owns the claim, and moves the claim off it. See cmdAdd for why it is a bare
// UUID and why it does not require a prior `remove`.

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
import {
  escapeUnsafeDisplayChars,
  UNSAFE_DISPLAY_CHARS_RE,
} from "@/lib/security/unsafe-display-chars";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { createPrompter } from "./lib/prompt";
import {
  parseFlags,
  getStringFlag,
  findValuelessFlag,
  valuelessError,
} from "./lib/tenant-domain-flags";

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
export const migrationClientFactory = {
  create(connectionString: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  },
};

// `--tenant` resolution, in priority order:
//   1. a literal UUID names the tenant directly;
//   2. an already-registered claim (normalised the same way `--domain` is) —
//      the registry is authoritative, so it wins over 3;
//   3. `tenants.external_id` (@unique), exact match on the raw ref.
//
// 3 exists because a tenant that `preflight` reports as SKIPPED by the backfill
// (normalisation collision, or non-ASCII external_id) has no claim row at all,
// and would otherwise be nameable only by UUID at exactly the moment an
// operator is trying to repair it. It matches the raw ref rather than the
// normalised one because the column is stored, and matched elsewhere, verbatim
// (D-3's release-1 externalId fallback is an exact match too); normalising here
// would resolve refs that no other code path resolves.
//
// `tenants.slug` is deliberately NOT a resolution path (round-2 F-F). A
// sign-in-created tenant gets `slug = slugifyTenant(rawClaim)`, which collapses
// `[^a-z0-9]+`, so the mapping from IdP claim to slug is many-to-one and the
// first tenant to take a slug keeps it: an attacker who can cause one tenant to
// be created — the same "one mistyped or squatted sign-in" cmdAdd's `--from`
// comment names — can pre-empt the slug an operator would later type (assert
// `"acme com"` to own `acme-com`). `--tenant` names the GAINING side of a
// reassignment, so a wrong resolution hands the claim to the attacker's tenant,
// and `--yes` removes the visual check. `external_id` carries no such hazard:
// it is @unique and matched verbatim, so the ref the operator types names at
// most one tenant, and owning it requires having asserted that exact string
// before the legitimate tenant existed. Dropping slug costs no reachability
// either — every tenant `preflight` reports has a non-null `external_id` by
// construction (all three of its queries require it), which is the need 3 was
// added for.
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
  if (row) {
    return tx.tenant.findUnique({ where: { id: row.tenantId }, select });
  }

  return tx.tenant.findUnique({ where: { externalId: ref }, select });
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

// ─── list ────────────────────────────────────────────────────────

export async function cmdList(args: { tenant?: string }): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = migrationClientFactory.create(url);
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
          console.log(
            `${escapeUnsafeDisplayChars(row.claim)}\ttenant=${row.tenantId}\tcreatedBy=${createdBy}\tcreatedAt=${row.createdAt.toISOString()}\t${status}`,
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

type UnmappedRow = {
  tenant_id: string;
  claim: string;
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
  // AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS, the same threshold the worker's own
  // reaper uses to declare a claim abandoned, so this report cannot disagree
  // with the component that acts on it.
  undelivered_cnt: bigint | number;
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
// worker still considers its own. A second, independently-picked number here
// would let this report and the reaper disagree about the same row.
const PROCESSING_LEASE_SECONDS = Math.ceil(
  AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / MS_PER_SECOND,
);

// Pure — exported so a test can pin the S12 "empty is not the same as
// silent" wording without depending on the shared dev DB happening to have
// zero real tenant_claim_unmapped denials at test time (other working
// copies on this same feature branch may be exercising sign-in concurrently).
export function formatUnmappedMessage(rows: UnmappedRow[], days: number): string {
  if (rows.length === 0) {
    return (
      `No unmapped-claim denials in the last ${days} days. That is the window this query ` +
      `covered, NOT this deployment's retention — a denial older than ${days} days is ` +
      "outside it whether or not the row still exists. Re-run with --days <n> to widen. " +
      "An empty result does NOT by itself mean nothing was denied."
    );
  }
  const undelivered = rows.reduce((sum, r) => sum + Number(r.undelivered_cnt), 0);
  const base = `${rows.length} unmapped-claim denial group(s) in the last ${days} days.`;
  if (undelivered === 0) return base;
  // Round-2 F-B: the operator must see that outbox delivery itself is degraded,
  // because these rows are the ones that would have been INVISIBLE while the
  // union looked only at PENDING — a report that under-reports precisely in the
  // stopped/crashed-worker case the union exists to cover.
  return (
    `${base} ${undelivered} of the denial event(s) are stranded in audit_outbox (FAILED, or ` +
    "PROCESSING past the worker's claim lease): the outbox worker's delivery is degraded, " +
    "so those events will not reach audit_logs without operator action."
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
        const rows = await tx.$queryRawUnsafe<UnmappedRow[]>(
          `SELECT tenant_id::text AS tenant_id, claim, count(*)::int AS cnt,
                  max(created_at) AS last_seen, sum(undelivered)::int AS undelivered_cnt
             FROM (
               SELECT tenant_id, metadata->>'claim' AS claim, created_at, 0 AS undelivered
                 FROM audit_logs
                WHERE action = 'AUTH_LOGIN_FAILURE'::"AuditAction"
                  AND metadata->>'reason' = 'tenant_claim_unmapped'
                  AND created_at >= now() - make_interval(days => $1::int)
               UNION ALL
               SELECT tenant_id, payload->'metadata'->>'claim' AS claim, created_at,
                      CASE
                        WHEN status = 'PENDING'::"AuditOutboxStatus" THEN 0
                        WHEN status = 'PROCESSING'::"AuditOutboxStatus"
                             AND processing_started_at > now() - make_interval(secs => $2::int) THEN 0
                        ELSE 1
                      END AS undelivered
                 FROM audit_outbox
                WHERE status <> 'SENT'::"AuditOutboxStatus"
                  AND payload->>'action' = 'AUTH_LOGIN_FAILURE'
                  AND payload->'metadata'->>'reason' = 'tenant_claim_unmapped'
                  AND created_at >= now() - make_interval(days => $1::int)
             ) combined
            WHERE claim IS NOT NULL
            GROUP BY tenant_id, claim
            ORDER BY last_seen DESC`,
          days,
          PROCESSING_LEASE_SECONDS,
        );

        // Round-3 A3, and here it is not merely defensive: `claim` comes out
        // of audit_logs.metadata / audit_outbox.payload, neither of which is
        // CHECK-constrained, and rows written before this PR's ingest boundary
        // landed can still carry U+202E. This is the report an operator reads
        // while deciding which claim to register, so a value that renders as
        // something other than what it is would be acted on.
        for (const row of rows) {
          const undelivered = Number(row.undelivered_cnt);
          console.log(
            `  tenant=${row.tenant_id}  claim="${escapeUnsafeDisplayChars(row.claim)}"  count=${Number(row.cnt)}  lastSeen=${new Date(row.last_seen).toISOString()}` +
              (undelivered > 0 ? `  undelivered=${undelivered}` : ""),
          );
        }

        // S12: an empty result says so explicitly, with the window it
        // checked, rather than rendering as an indistinguishable empty list
        // — printed via `message` (not console.log here) so both the CLI
        // wrapper AND the integration test observe the identical text,
        // without depending on the shared dev DB happening to be globally
        // empty of unmapped-claim denials at test time.
        const message = formatUnmappedMessage(rows, days);

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

// Bound on the one pre-flight query that materialises rows instead of an
// aggregate. Chosen well above any plausible tenant count for this
// deployment shape (264 today) so it is a backstop, not a paging scheme.
const PREFLIGHT_FOLD_SCAN_LIMIT = 50_000;

export async function cmdPreflight(): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  const prisma = migrationClientFactory.create(url);
  try {
    return await withBypassRls(
      prisma,
      async (tx) => {
        // Query 1 — normalisation collisions: tenants whose RAW external_id
        // folds (lower(btrim(x) COLLATE "C"), matching the CHECK/backfill —
        // round-5 D3) to the same claim as another tenant's. The backfill
        // excludes EVERY side of a collision (round-1 M3, via its
        // `NOT IN (… GROUP BY 1 HAVING count(*) > 1)` clause — not via
        // ON CONFLICT, which now only covers a claim row that already exists),
        // so none of the tenants listed here gets a claim row at all. They keep
        // resolving through the release-1 exact-match external_id fallback
        // until an operator decides who owns the claim; a third spelling that
        // neither stores verbatim is refused rather than allowed to squat the
        // free slot (round-2 F-A, findOrCreateTenantForClaim's
        // claim_collision arm).
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
        //
        // This is the one query that pulls whole rows into memory rather
        // than an aggregate, so it carries an explicit bound. Fetching
        // LIMIT+1 makes truncation detectable, and a truncated scan says so
        // loudly — a silently short scan here would be the "confidently
        // wrong all-clear" pre-flight exists to prevent.
        const scanned = await tx.$queryRawUnsafe<RawExternalIdRow[]>(
          `SELECT id, external_id, lower(btrim(external_id) COLLATE "C") AS pg_fold
             FROM tenants
            WHERE external_id IS NOT NULL
              AND btrim(external_id) <> ''
            ORDER BY id
            LIMIT $1::int`,
          PREFLIGHT_FOLD_SCAN_LIMIT + 1,
        );
        const foldScanTruncated = scanned.length > PREFLIGHT_FOLD_SCAN_LIMIT;
        const allExternalIds = foldScanTruncated
          ? scanned.slice(0, PREFLIGHT_FOLD_SCAN_LIMIT)
          : scanned;
        const foldMismatches = allExternalIds
          .filter((r) => r.pg_fold !== normalizeTenantClaim(r.external_id))
          .map((r) => ({
            id: r.id,
            externalId: r.external_id,
            pgFold: r.pg_fold,
            jsFold: normalizeTenantClaim(r.external_id),
          }));

        // Every value below is escaped for display (round-3 A3). This command
        // is the one place in the tool whose PURPOSE is to report values that
        // are not printable ASCII — `tenants.external_id` carries no CHECK,
        // and the non-ASCII query exists precisely to surface the rows the
        // backfill excluded. Printing those verbatim would put a bidi override
        // on the operator's terminal in the report that exists to warn them
        // about it.
        console.log("Pre-upgrade checks (C12):");
        console.log(`  normalisation collisions: ${collisions.length}`);
        for (const c of collisions) {
          console.log(
            `    claim="${escapeUnsafeDisplayChars(c.normalized_claim)}" tenants=${c.tenant_ids.join(",")} count=${Number(c.collision_count)}`,
          );
        }
        console.log(`  non-ASCII external_id (excluded by backfill): ${nonAscii.length}`);
        for (const n of nonAscii) {
          console.log(`    tenant=${n.id} external_id="${escapeUnsafeDisplayChars(n.external_id)}"`);
        }
        console.log(
          `  Postgres/JS fold mismatches: ${foldMismatches.length} (over ${allExternalIds.length} tenant(s) scanned)`,
        );
        for (const m of foldMismatches) {
          console.log(
            `    tenant=${m.id} external_id="${escapeUnsafeDisplayChars(m.externalId)}" ` +
              `pgFold="${escapeUnsafeDisplayChars(m.pgFold)}" jsFold="${escapeUnsafeDisplayChars(m.jsFold)}"`,
          );
        }
        if (foldScanTruncated) {
          console.log(
            `    WARNING: more than ${PREFLIGHT_FOLD_SCAN_LIMIT} tenants carry an external_id; ` +
              "the fold-mismatch scan covered only the first page (ordered by id). " +
              "Treat this result as INCOMPLETE.",
          );
        }

        const message =
          `${collisions.length} collision(s), ${nonAscii.length} non-ASCII, ` +
          `${foldMismatches.length} fold mismatch(es)` +
          (foldScanTruncated ? ` (fold scan TRUNCATED at ${PREFLIGHT_FOLD_SCAN_LIMIT} tenants).` : ".");
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

const REASSIGNMENT_WARNING = [
  "Reassigning this claim takes it AWAY from the losing tenant shown above:",
  "from now on every sign-in presenting it selects the gaining tenant instead.",
  "A losing-tenant member who signs in through this claim and holds no other",
  "registered claim is denied from that moment on. Nothing already signed in is",
  "logged out, no data moves back, and no estate absorbed under the old owner is",
  "returned by this command.",
].join("\n");

export async function cmdAdd(args: {
  tenant: string;
  domain: string;
  by: string;
  from?: string;
  yes?: boolean;
  confirm?: ConfirmFn;
}): Promise<CmdResult> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) return missingUrlResult();

  if (!args.by || args.by.trim().length === 0) {
    return { ok: false, code: 1, message: "--by is required (a self-asserted operator label)." };
  }

  // `--by` is stored verbatim in TenantClaim.createdBy, which no CHECK
  // constrains, and it is read back by `list` and by the next operator's `add`
  // preview — the audit trail the whole soft-delete design (S3-4) rests on.
  // A label carrying a bidi override would misrepresent who registered a claim
  // at exactly the moment someone is deciding whether to trust the row.
  // Rejected rather than escaped on the way in, matching the claim ingest
  // boundary: what is stored stays what was typed.
  if (UNSAFE_DISPLAY_CHARS_RE.test(args.by)) {
    return {
      ok: false,
      code: 1,
      message:
        "--by contains a control, bidi or zero-width character. Use a plain label: " +
        "it is stored as the registration's attribution and read back by `list`.",
    };
  }

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
        `Invalid --from "${args.from}": expected the current owner's tenant UUID, ` +
        'exactly as "list" prints it. --from is not resolved through slugs, claims ' +
        "or external ids — a claim reassignment must not be reachable by a typo.",
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
      message: `Invalid --domain "${args.domain}": ${parsed.error.issues[0]?.message ?? "does not satisfy operatorDomainSchema"} (example: alias.example)`,
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
          return { ok: false, code: 1, message: `Tenant not found: ${args.tenant}` };
        }

        // The ONE tenantClaim.findUnique call site outside
        // tenant-management.ts's resolver (C3/C4): this command's D2
        // semantics need the owning tenant AND the revoked state, which
        // resolveTenantByClaim deliberately does not expose (it filters
        // revoked rows to null so sign-in cannot resurrect them silently).
        const existing = await tx.tenantClaim.findUnique({
          where: { claim },
          select: { id: true, tenantId: true, revokedAt: true, createdBy: true, createdAt: true },
        });

        if (args.from !== undefined && !existing) {
          return {
            ok: false,
            code: 1,
            message: `--from was given but claim "${claim}" is not registered to any tenant — there is nothing to reassign. Re-run without --from to register it.`,
          };
        }
        if (args.from !== undefined && existing && args.from !== existing.tenantId) {
          return {
            ok: false,
            code: 1,
            message: `--from ${args.from} does not own claim "${claim}" — tenant ${existing.tenantId} does. Refusing to reassign; naming the actual current owner is what makes this a deliberate act rather than a typo.`,
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
              `Claim "${claim}" is ${state} tenant ${existing.tenantId}, not ${tenant.id}. ` +
              "Refusing to reassign implicitly. To move it, name the current owner: " +
              `add --tenant ${tenant.id} --domain ${claim} --by <label> --from ${existing.tenantId}. ` +
              '("remove" does not free a claim — it soft-deletes, leaving the owner unchanged.)',
          };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);

        // D2 idempotency (VE2): already owned by this tenant and not
        // revoked — success, no write, no confirmation prompt (nothing is
        // about to mutate).
        if (existing && !isReassignment && existing.revokedAt === null) {
          printTenantSummary(tenant, activeMembers);
          console.log(`Claim "${claim}" is already registered to this tenant. No change made.`);
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
        console.log(`  claim: ${claim}`);
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
        if (existing && isReassignment) {
          const moved = await tx.tenantClaim.updateMany({
            where: { id: existing.id, tenantId: existing.tenantId },
            data: { tenantId: tenant.id, revokedAt: null },
          });
          if (moved.count === 0) {
            return {
              ok: false,
              code: 1,
              message: `Claim "${claim}" was modified concurrently by another process. Re-run "list" to see its current owner.`,
            };
          }
        } else if (existing) {
          // M2 / SC8: `createdBy` is NOT overwritten with `--by`. SC8 defers
          // application-level audit for claim registration on the premise
          // that "the row itself carries the timeline and the self-asserted
          // actor an incident needs" — overwriting it on the un-revoke path
          // erased exactly that, leaving no record of who first registered
          // the claim. The un-revoker is recorded only in this command's
          // printed output; recording it in the row needs a new column, and
          // therefore a migration, which is out of scope here.
          const unrevoked = await tx.tenantClaim.updateMany({
            where: { id: existing.id, tenantId: tenant.id },
            data: { revokedAt: null },
          });
          if (unrevoked.count === 0) {
            return {
              ok: false,
              code: 1,
              message: `Claim "${claim}" was modified concurrently by another process. Re-run "list" to see its current state.`,
            };
          }
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

        if (existing && isReassignment) {
          console.log(`Reassigned claim "${claim}" from tenant ${existing.tenantId} to tenant ${tenant.id}.`);
        } else if (existing) {
          console.log(`Un-revoked claim "${claim}" for tenant ${tenant.id}.`);
        } else {
          console.log(`Registered claim "${claim}" for tenant ${tenant.id}.`);
        }
        if (existing) {
          console.log(
            `createdBy stays "${existing.createdBy ?? "-"}" (${existing.createdAt.toISOString()}) — the row records who ` +
              `FIRST registered this claim, not who last changed it. This change was made by "${args.by}"; that is ` +
              "recorded only here, so keep this output with the incident record.",
          );
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

  const prisma = migrationClientFactory.create(url);
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

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  tenant-domain list [--tenant <ref>]",
      `  tenant-domain unmapped [--days <n>]            (default ${DEFAULT_UNMAPPED_WINDOW_DAYS})`,
      "  tenant-domain preflight",
      "  tenant-domain add    --tenant <ref> --domain <domain> --by <label> [--from <current-owner-uuid>] [--yes]",
      "  tenant-domain remove --tenant <ref> --domain <domain> [--yes]",
      "",
      "<ref> is a tenant UUID, one of its registered claims, or its external id (not its slug).",
      "--from moves a claim off the tenant that currently owns it; it takes that tenant's",
      "UUID only, and `add` refuses if it does not match the row's actual owner.",
      "",
      "MIGRATION_DATABASE_URL must be set to a privileged connection string.",
      "Example: MIGRATION_DATABASE_URL=postgresql://... npm run tenant-domain -- add --tenant acmecorp --domain alias.example --by ops-oncall",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const parsed = parseFlags(rest);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const flags = parsed.flags;
  const yes = flags.get("yes") === true;

  const valueless = findValuelessFlag(flags);
  if (valueless) {
    console.error(valuelessError(valueless));
    process.exitCode = 1;
    return;
  }

  let result: CmdResult;
  switch (subcommand) {
    case "list":
      result = await cmdList({ tenant: getStringFlag(flags, "tenant") });
      break;
    case "unmapped": {
      const rawDays = getStringFlag(flags, "days");
      if (rawDays !== undefined && !/^\d+$/.test(rawDays)) {
        console.error(`Invalid --days "${rawDays}": expected a positive integer number of days.`);
        process.exitCode = 1;
        return;
      }
      result = await cmdUnmapped(rawDays === undefined ? {} : { days: Number(rawDays) });
      break;
    }
    case "preflight":
      result = await cmdPreflight();
      break;
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
      result = await cmdAdd({ tenant, domain, by, from, yes });
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
