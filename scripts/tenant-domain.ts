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
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add     --tenant <ref> --domain <domain> --by <label> [--from <current-owner-uuid>] [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove  --tenant <ref> --domain <domain> --by <label> [--yes]
//   MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- history --domain <claim> | --tenant <uuid> [--after <seq>]
//
// `--tenant <ref>` accepts the tenant's UUID, one of its already-registered
// claims (normalised the same way `add`/`remove` normalise `--domain`), or its
// `tenants.external_id`. The last matters at incident time: a tenant whose
// backfill row `preflight` reports as skipped has NO claim row, and would
// otherwise be nameable only by UUID. `tenants.slug` is NOT accepted — see
// resolveTenantRef for why (round-2 F-F).
//
// `--by` is a self-asserted operator label (NOT authenticated attribution —
// there is no application user identity on this connection, see SC8). It is
// stored verbatim in TenantClaim.createdBy only when a row is CREATED —
// deliberately not overwritten on the un-revoke or reassign paths, which
// preserve the original registrant, see cmdAdd — but that is `createdBy`
// specifically, not the flag. `--by` ALSO supplies `actor_label` on the
// `tenant_claim_events` row every one of the four verbs (register / revoke /
// unrevoke / reassign) appends in the same transaction (SC11 / #743), which
// is why `remove` requires it too, not just `add`. See `tenant-domain
// history` to read those rows back.
//
// `--from` is `add`'s reassignment flag: it names the tenant that currently
// owns the claim, and moves the claim off it. See cmdAdd for why it is a bare
// UUID and why it does not require a prior `remove`.
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
import { UUID_RE, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import {
  escapeUnsafeDisplayChars,
  UNSAFE_DISPLAY_CHARS_RE,
} from "@/lib/security/unsafe-display-chars";
import {
  recordTenantClaimEvent,
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
} from "@/lib/tenant/tenant-claim-event";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { MS_PER_SECOND } from "@/lib/constants/time";
import {
  asciiPrintable, AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { createPrompter } from "./lib/prompt";
import {
  parseFlags,
  getStringFlag,
  findValuelessFlag,
  valuelessError,
} from "./lib/tenant-domain-flags";
import {
  bucketOf,
  UNMAPPED_BUCKET,
  UNMAPPED_SELECTED_REASONS,
  type UnmappedBucket,
} from "./lib/tenant-domain-buckets";

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
            return { ok: false, code: 1, message: `Tenant not found: ${escapeUnsafeDisplayChars(args.tenant)}` };
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
      `No claim-bearing sign-in denials — unregistered, other-tenant or refused — in the ` +
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
    `${count(UNMAPPED_BUCKET.OTHER_TENANT)} other-tenant and ` +
    `${count(UNMAPPED_BUCKET.REFUSED)} refused-claim denial group(s) in the last ${days} days.`;
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
                  count(*)::int AS cnt, max(created_at) AS last_seen,
                  sum(undelivered)::int AS undelivered_cnt
             FROM (
               SELECT tenant_id, metadata->>'claim' AS claim,
                      metadata->>'claimRefusal' AS claim_refusal,
                      metadata->>'reason' AS reason, created_at, 0 AS undelivered
                 FROM audit_logs
                WHERE action = 'AUTH_LOGIN_FAILURE'::"AuditAction"
                  AND metadata->>'reason' = ANY($3::text[])
                  AND created_at >= now() - make_interval(days => $1::int)
               UNION ALL
               SELECT tenant_id, payload->'metadata'->>'claim' AS claim,
                      payload->'metadata'->>'claimRefusal' AS claim_refusal,
                      payload->'metadata'->>'reason' AS reason, created_at,
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
            GROUP BY tenant_id, claim, claim_refusal, reason
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

// ─── shared: --by validation ────────────────────────────────────

// Sized to `tenant_claim_events.actor_label VARCHAR(255)`
// (prisma/migrations/20260731100000_add_tenant_claim_events) — the column
// every one of the four verbs writes `--by` into as attribution.
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
  if (by.trim().toLowerCase() === SIGNIN_ACTOR_LABEL) {
    return {
      ok: false,
      code: 1,
      message:
        `--by must not be "${SIGNIN_ACTOR_LABEL}": that label is reserved for the sign-in ` +
        "auto-registration path, and a routing event carrying it would read as engine-written " +
        "rather than operator-asserted. Use your own identifier.",
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

  const byError = validateActorLabel(args.by);
  if (byError) return byError;

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
        // takes UUID → existing claim → external_id, so the sentinel has TWO
        // spellings that reach here: its UUID, and any claim already pointing
        // at it — which is the spelling an operator uses during exactly the
        // incident this refusal is about. A check on the ref string would pass
        // for the second. (Its slug is not a third: slug is deliberately not a
        // resolution path, and the sentinel carries no external_id.)
        //
        // `add` is the only creator of a sentinel claim. The sign-in JIT path
        // builds its claim as a nested write inside tenant.create, so it always
        // targets a NEW tenant, and the backfill filters on external_id, which
        // the sentinel row does not have.
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
          select: { id: true, tenantId: true, revokedAt: true, createdBy: true, createdAt: true },
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
              `add --tenant ${tenant.id} --domain ${escapeUnsafeDisplayChars(claim)} --by <label> --from ${existing.tenantId}. ` +
              '("remove" does not free a claim — it soft-deletes, leaving the owner unchanged.)',
          };
        }

        const activeMembers = await activeMemberCount(tx, tenant.id);

        // D2 idempotency (VE2): already owned by this tenant and not
        // revoked — success, no write, no confirmation prompt (nothing is
        // about to mutate).
        if (existing && !isReassignment && existing.revokedAt === null) {
          printTenantSummary(tenant, activeMembers);
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
          const moved = await tx.tenantClaim.updateMany({
            where: { id: existing.id, tenantId: existing.tenantId, revokedAt: existing.revokedAt },
            data: { tenantId: tenant.id, revokedAt: null },
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
            where: { id: existing.id, tenantId: tenant.id, revokedAt: existing.revokedAt },
            data: { revokedAt: null },
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
          });
        } else {
          try {
            await tx.tenantClaim.create({ data: { tenantId: tenant.id, claim, createdBy: args.by } });
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
          select: { id: true, tenantId: true, revokedAt: true, createdAt: true },
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
        const revokedAt = new Date();
        const result = await tx.tenantClaim.updateMany({
          where: { claim, tenantId: tenant.id, revokedAt: null },
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
        });

        console.log(`Revoked claim "${escapeUnsafeDisplayChars(claim)}" for tenant ${tenant.id}.`);
        return { ok: true, code: 0, tenantId: tenant.id, claim };
      },
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
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
      "  tenant-domain list    [--tenant <ref>]",
      `  tenant-domain unmapped [--days <n>]           (default ${DEFAULT_UNMAPPED_WINDOW_DAYS})`,
      "  tenant-domain preflight",
      "  tenant-domain add     --tenant <ref> --domain <domain> --by <label> [--from <current-owner-uuid>] [--yes]",
      "  tenant-domain remove  --tenant <ref> --domain <domain> --by <label> [--yes]",
      "  tenant-domain history --domain <claim> | --tenant <uuid> [--after <seq>]",
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
