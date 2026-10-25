/**
 * The pure halves of `tenant-domain`'s claim-binding commands (plan
 * sso-claim-connection-binding, C3/C4): the member evidence and its canonical
 * string, the majority rule, the bind file's format, the worktree check
 * `bind --from-members --out` applies to its target, the mapping of a
 * stored sign-in provider ref back to a provider id, and `legacy-accounts`'
 * grouping and verdict.
 *
 * In its own module for the same reason as `tenant-domain-flags.ts`: it can be
 * unit-tested without importing the CLI (which pulls in Prisma, the driver
 * adapter and `loadEnv()`).
 *
 * ONE evidence formatter, shared by `--out` (which writes it) and `--apply`
 * (which recomputes it and compares strings). Two formatters would let a
 * reordering or a zero count read as "the evidence changed" — or, worse, let a
 * real change read as identical.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { UUID_RE } from "@/lib/constants/app";
import { isProviderIdShape } from "@/lib/auth/jackson-providers";
import { providerRef } from "@/lib/audit/identifier-pepper";
import {
  escapeUnsafeDisplayChars,
  UNSAFE_DISPLAY_CHARS_RE,
} from "@/lib/security/unsafe-display-chars";
import { storableClaimSchema } from "@/lib/tenant/tenant-claim-registry";

// ─── evidence ────────────────────────────────────────────────────

/** The two fixed keys that close every evidence string. */
export const EVIDENCE_KEY = {
  NONE: "none",
  TOTAL: "total",
} as const;

/**
 * Per claim provider, how many of a tenant's active members hold an account
 * there; `none` counts the members holding none at any of them. A member with
 * accounts at two providers counts under both.
 */
export type ClaimEvidence = {
  readonly total: number;
  readonly none: number;
  readonly counts: ReadonlyMap<string, number>;
};

/** One active member and the providers of its accounts. */
export type MemberAccounts = { readonly userId: string; readonly providers: readonly string[] };

/** The evidence over `members`, counting only providers in `universe`. Order-independent. */
export function evidenceOf(
  members: readonly MemberAccounts[],
  universe: ReadonlySet<string>,
): ClaimEvidence {
  const counts = new Map<string, number>();
  let none = 0;
  for (const member of members) {
    const held = new Set(member.providers.filter((p) => universe.has(p)));
    if (held.size === 0) none += 1;
    for (const provider of held) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return { total: members.length, none, counts };
}

/**
 * The canonical string: `<provider>=<n>` sorted by provider id, zero counts
 * omitted, then `none=<n>;total=<n>`, joined by `;`. Provider ids match
 * PROVIDER_ID_PATTERN, so neither `=` nor `;` can occur inside one.
 */
export function formatEvidence(evidence: ClaimEvidence): string {
  const providers = [...evidence.counts.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, n]) => `${provider}=${n}`);
  return [...providers, `${EVIDENCE_KEY.NONE}=${evidence.none}`, `${EVIDENCE_KEY.TOTAL}=${evidence.total}`].join(";");
}

/** The evidence a canonical string states, or null for anything `formatEvidence` would not write. */
export function parseEvidence(text: string): ClaimEvidence | null {
  const parts = text.split(";");
  if (parts.length < 2) return null;
  const pairs: Array<[string, number]> = [];
  for (const part of parts) {
    const m = /^([a-z0-9-]+)=(0|[1-9]\d*)$/.exec(part);
    if (!m) return null;
    pairs.push([m[1], Number(m[2])]);
  }
  const total = pairs.pop();
  const none = pairs.pop();
  if (!total || !none || total[0] !== EVIDENCE_KEY.TOTAL || none[0] !== EVIDENCE_KEY.NONE) return null;
  const counts = new Map<string, number>();
  for (const [provider, n] of pairs) {
    if (!isProviderIdShape(provider) || counts.has(provider)) return null;
    counts.set(provider, n);
  }
  const evidence: ClaimEvidence = { total: total[1], none: none[1], counts };
  return formatEvidence(evidence) === text ? evidence : null;
}

/**
 * The provider to suggest: the one claim provider every active member holds an
 * account at, and no other. Null with zero members (nothing to suggest from),
 * with a member at none, or with any member at a second provider.
 */
export function suggestedProvider(evidence: ClaimEvidence): string | null {
  if (evidence.total === 0 || evidence.none !== 0) return null;
  const used = [...evidence.counts.entries()].filter(([, n]) => n > 0);
  if (used.length !== 1) return null;
  const [provider, n] = used[0];
  return n === evidence.total ? provider : null;
}

/** Strictly more than half of the active members — exactly half is not a majority. */
export function isMajority(count: number, total: number): boolean {
  return total > 0 && count * 2 > total;
}

// ─── bind file ───────────────────────────────────────────────────

export const BIND_FILE_FORMAT = "passwd-sso-claim-bind";
export const BIND_FILE_VERSION = "v1";
/** The first line of every bind file: the format and its version, tab-separated. */
export const BIND_FILE_HEADER = `${BIND_FILE_FORMAT}\t${BIND_FILE_VERSION}`;
export const BIND_FILE_COLUMNS = ["claim", "tenant_id", "provider", "evidence"] as const;

/** What the reviewing operator is shown above a line: the row's provenance. */
export type BindRowFlags = {
  readonly createdBy: string | null;
  /** The claim equals the tenant's own id — the backfilled `external_id = id` shape. */
  readonly uuidClaim: boolean;
  /** Operator `reassign` / `unrevoke` events on the claim, oldest first. */
  readonly operatorEvents: readonly string[];
  /** The `register` event's provider; null for a pre-change event or no event. */
  readonly registerProvider: string | null;
};

export type BindFileRow = {
  readonly claim: string;
  readonly tenantId: string;
  readonly evidence: ClaimEvidence;
  readonly flags: BindRowFlags;
};

/** The flag line's text, every free-text value escaped so no stored value can end the line. */
export function formatFlags(flags: BindRowFlags): string {
  return [
    `created_by=${flags.createdBy === null ? "-" : escapeUnsafeDisplayChars(flags.createdBy)}`,
    `uuid_claim=${flags.uuidClaim ? "yes" : "no"}`,
    `operator_events=${flags.operatorEvents.length === 0 ? "none" : flags.operatorEvents.map(escapeUnsafeDisplayChars).join(",")}`,
    `register_provider=${flags.registerProvider === null ? "unknown" : escapeUnsafeDisplayChars(flags.registerProvider)}`,
  ].join("; ");
}

/** What starts a comment line, which `parseBindFile` skips. */
const BIND_FILE_COMMENT_PREFIX = "#";

/**
 * Whether a stored claim can be a bind file data line. A claim starting with
 * `#` is printable ASCII, so the registry stores it, but its line would read
 * back as a comment and be skipped without a word — so it is not written, and
 * `formatBindFile` lists it in a note instead.
 */
export function isBindFileWritable(claim: string): boolean {
  return !claim.startsWith(BIND_FILE_COMMENT_PREFIX);
}

/**
 * The whole file. Rows in the order given; each data line under its own flag
 * line. The claim column is written as stored, not escaped: the
 * `tenant_claims_claim_normalized` CHECK holds it to printable ASCII, so it
 * cannot carry a tab or a line break, and escaping `<` would turn it into a
 * different claim that `--apply` then fails to find. A claim outside that
 * class throws rather than being written. A claim `isBindFileWritable` refuses
 * is listed in a "not written" note at the top instead of as a line.
 */
export function formatBindFile(rows: readonly BindFileRow[]): string {
  const notWritten = rows.filter((row) => !isBindFileWritable(row.claim));
  const lines: string[] = [
    BIND_FILE_HEADER,
    "# tenant-domain bind file: every active tenant claim with no provider binding.",
    `# Columns (tab-separated): ${BIND_FILE_COLUMNS.join(", ")}. Lines starting with # are comments.`,
    "# provider is filled only when every active member of the tenant holds an account at exactly one",
    "# claim provider. Review every line: set provider to the connection that tenant's IdP sits behind,",
    "# or leave it empty to skip the line. Do not edit evidence; --apply recomputes and compares it.",
    "# This file lists every tenant's claims: keep it outside the repository and delete it after --apply.",
  ];
  if (notWritten.length > 0) {
    lines.push(
      `# Not written: ${notWritten.length} claim(s) starting with "${BIND_FILE_COMMENT_PREFIX}", which this file would`,
      "# read back as comments. Bind each one with `tenant-domain bind --claim <claim> --provider <id> --by <label>`:",
      ...notWritten.map((row) => `#   ${escapeUnsafeDisplayChars(row.claim)} (tenant ${row.tenantId})`),
    );
  }
  for (const row of rows) {
    if (!storableClaimSchema.safeParse(row.claim).success) {
      throw new Error(`bind file: stored claim "${escapeUnsafeDisplayChars(row.claim)}" is not printable ASCII`);
    }
    if (!isBindFileWritable(row.claim)) continue;
    lines.push(`# ${escapeUnsafeDisplayChars(row.claim)}: ${formatFlags(row.flags)}`);
    lines.push(
      [row.claim, row.tenantId, suggestedProvider(row.evidence) ?? "", formatEvidence(row.evidence)].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

export type BindFileLine = {
  /** 1-based line number in the file. */
  readonly lineNo: number;
  readonly claim: string;
  readonly tenantId: string;
  /** The operator's choice; null when the line is left empty (not applied). */
  readonly provider: string | null;
  readonly evidence: string;
};

export type BindFileParse =
  | { ok: true; lines: readonly BindFileLine[] }
  | { ok: false; errors: readonly string[] };

/**
 * Validates the WHOLE file before anything is applied: header and version,
 * column count, a storable claim, a tenant UUID, a provider in `claimProviders`
 * (or empty), a canonical evidence string, no claim twice. Any error refuses
 * the file; every value echoed in an error is escaped.
 */
export function parseBindFile(text: string, claimProviders: ReadonlySet<string>): BindFileParse {
  // Refused up front, by name: an editor that saved the file with a BOM or
  // CRLF endings otherwise surfaces as a header mismatch or a carriage return
  // in the evidence column, neither of which says what to change.
  if (text.startsWith("\uFEFF")) {
    return { ok: false, errors: ["the file starts with a byte-order mark: save it with LF line endings, no BOM"] };
  }
  if (text.includes("\r\n")) {
    return { ok: false, errors: ["the file has CRLF line endings: save it with LF line endings, no BOM"] };
  }
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const errors: string[] = [];
  const [header, ...body] = raw;
  const headerCells = (header ?? "").split("\t");
  if (headerCells[0] !== BIND_FILE_FORMAT || headerCells.length !== 2) {
    errors.push(
      `line 1: expected the header "${BIND_FILE_FORMAT}<TAB>${BIND_FILE_VERSION}", got "${escapeUnsafeDisplayChars(header ?? "")}"`,
    );
    return { ok: false, errors };
  }
  if (headerCells[1] !== BIND_FILE_VERSION) {
    errors.push(
      `line 1: unknown bind file version "${escapeUnsafeDisplayChars(headerCells[1])}"; this tool reads ${BIND_FILE_VERSION}`,
    );
    return { ok: false, errors };
  }

  const lines: BindFileLine[] = [];
  const seen = new Map<string, number>();
  body.forEach((line, index) => {
    const lineNo = index + 2;
    if (line === "" || line.startsWith(BIND_FILE_COMMENT_PREFIX)) return;
    const cells = line.split("\t");
    if (cells.length !== BIND_FILE_COLUMNS.length) {
      errors.push(
        `line ${lineNo}: expected ${BIND_FILE_COLUMNS.length} tab-separated columns, got ${cells.length}: "${escapeUnsafeDisplayChars(line)}"`,
      );
      return;
    }
    const unsafe = cells.findIndex((cell) => UNSAFE_DISPLAY_CHARS_RE.test(cell));
    if (unsafe !== -1) {
      errors.push(
        `line ${lineNo}: ${BIND_FILE_COLUMNS[unsafe]} contains a control, bidi or zero-width character: "${escapeUnsafeDisplayChars(cells[unsafe])}"`,
      );
      return;
    }
    const [claim, tenantId, provider, evidence] = cells;
    if (!storableClaimSchema.safeParse(claim).success) {
      errors.push(`line ${lineNo}: "${escapeUnsafeDisplayChars(claim)}" is not a stored claim`);
      return;
    }
    if (!UUID_RE.test(tenantId)) {
      errors.push(`line ${lineNo}: tenant_id "${escapeUnsafeDisplayChars(tenantId)}" is not a UUID`);
      return;
    }
    if (provider !== "" && !claimProviders.has(provider)) {
      errors.push(
        `line ${lineNo}: provider "${escapeUnsafeDisplayChars(provider)}" is not a configured claim provider`,
      );
      return;
    }
    if (parseEvidence(evidence) === null) {
      errors.push(`line ${lineNo}: evidence "${escapeUnsafeDisplayChars(evidence)}" is not in the canonical form`);
      return;
    }
    const earlier = seen.get(claim);
    if (earlier !== undefined) {
      errors.push(`line ${lineNo}: claim "${escapeUnsafeDisplayChars(claim)}" already appears on line ${earlier}`);
      return;
    }
    seen.set(claim, lineNo);
    lines.push({ lineNo, claim, tenantId, provider: provider === "" ? null : provider, evidence });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, lines };
}

// ─── worktree check ──────────────────────────────────────────────

/**
 * Whether `targetPath` would be created inside `worktreeTop`. Both sides are
 * resolved through `realpath` — the target's PARENT, since the target itself
 * must not exist yet — so a symlinked parent or a `..` cannot carry the file
 * into the repository past a string comparison. Throws when the parent does
 * not exist; the caller refuses then too.
 */
export function isInsideWorktree(targetPath: string, worktreeTop: string): boolean {
  const parent = realpathSync(dirname(resolve(targetPath)));
  const top = realpathSync(worktreeTop);
  return parent === top || parent.startsWith(top.endsWith(sep) ? top : `${top}${sep}`);
}

// ─── sign-in provider refs ───────────────────────────────────────

/** How `unmapped` prints a ref it cannot name a provider for. */
export const SIGN_IN_REF_LABEL = {
  /** The ref matches no configured claim provider: one since removed or renamed. */
  UNKNOWN: "unknown provider",
  /** This process has no pepper, so no ref can be computed to compare. */
  NO_PEPPER: "unmappable (no pepper)",
  /** This process has no claim providers configured to compute refs for. */
  NO_PROVIDERS: "unmappable (no provider configuration)",
  /** The app stored no ref — it had no pepper at the time. */
  NO_REF: "no ref stored",
} as const;

export type RefMapping =
  | { kind: "map"; idByRef: ReadonlyMap<string, string> }
  | { kind: "unmappable"; label: string };

/** The configured claim providers' refs under `pepper` — the same `providerRef` the app stores. */
export function refMappingFor(claimProviders: readonly string[], pepper: Buffer | null): RefMapping {
  if (pepper === null) return { kind: "unmappable", label: SIGN_IN_REF_LABEL.NO_PEPPER };
  if (claimProviders.length === 0) return { kind: "unmappable", label: SIGN_IN_REF_LABEL.NO_PROVIDERS };
  return { kind: "map", idByRef: new Map(claimProviders.map((id) => [providerRef(id, pepper), id])) };
}

/** A stored ref as the operator reads it: the provider id, or why it cannot be named. */
export function describeSignInProviderRef(ref: string | null, mapping: RefMapping): string {
  if (ref === null) return SIGN_IN_REF_LABEL.NO_REF;
  if (mapping.kind === "unmappable") return `${mapping.label} (ref ${escapeUnsafeDisplayChars(ref)})`;
  const id = mapping.idByRef.get(ref);
  return id ?? `${SIGN_IN_REF_LABEL.UNKNOWN} (ref ${escapeUnsafeDisplayChars(ref)})`;
}

// ─── legacy-accounts ─────────────────────────────────────────────

/**
 * The users holding pre-upgrade `saml-jackson` accounts, grouped by the tenant
 * of their active membership. `tenantId` null groups the users active nowhere.
 */
export type LegacyAccountGroup = {
  readonly tenantId: string | null;
  readonly users: number;
  readonly accounts: number;
};

/** Groups `accounts` by their user's active tenant, tenants in id order, the no-active group last. */
export function groupLegacyAccounts(
  accounts: readonly { readonly userId: string }[],
  activeTenantOf: ReadonlyMap<string, string>,
): LegacyAccountGroup[] {
  const byTenant = new Map<string | null, { users: Set<string>; accounts: number }>();
  for (const { userId } of accounts) {
    const tenantId = activeTenantOf.get(userId) ?? null;
    const group = byTenant.get(tenantId) ?? { users: new Set<string>(), accounts: 0 };
    group.users.add(userId);
    group.accounts += 1;
    byTenant.set(tenantId, group);
  }
  return [...byTenant.entries()]
    .map(([tenantId, group]) => ({ tenantId, users: group.users.size, accounts: group.accounts }))
    .sort((a, b) => (a.tenantId === null ? 1 : b.tenantId === null ? -1 : a.tenantId.localeCompare(b.tenantId)));
}

export const LEGACY_ACCOUNT_VERDICT = {
  /** No account records the legacy provider. */
  NONE: "none",
  /** The legacy provider is not configured, so no client resolves those accounts. */
  UNRESOLVED: "unresolved",
  /** Configured, and the accounts belong to one group's users. */
  ONE_GROUP: "one-group",
  /** Configured, and the accounts span more than one group: refused. */
  SPANS: "spans",
} as const;

export type LegacyAccountVerdict = (typeof LEGACY_ACCOUNT_VERDICT)[keyof typeof LEGACY_ACCOUNT_VERDICT];

/**
 * A tenant stands in for the connection its users came through: the accounts
 * do not record which connection that was. Users active nowhere count as one
 * more group, because a sign-in as them still gets a session; with any other
 * group present, one client resolves the users of two connections.
 */
export function legacyAccountVerdict(
  groups: readonly LegacyAccountGroup[],
  legacyConfigured: boolean,
): LegacyAccountVerdict {
  if (groups.length === 0) return LEGACY_ACCOUNT_VERDICT.NONE;
  if (!legacyConfigured) return LEGACY_ACCOUNT_VERDICT.UNRESOLVED;
  return groups.length > 1 ? LEGACY_ACCOUNT_VERDICT.SPANS : LEGACY_ACCOUNT_VERDICT.ONE_GROUP;
}
