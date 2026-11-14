import {
  AUDIT_ANCHOR_KID_HEX_CHARS,
  AUDIT_ANCHOR_KID_PREFIX,
} from "@/lib/constants/audit/audit";

/**
 * The three shapes a stored anchor artifact's key takes. The single source of
 * them: the anchors bucket policy's manifest pattern and break-glass paths are
 * pinned to these functions' output, and every destination refuses a key that
 * is none of them.
 */

export const STATEMENT_OP = {
  ROTATION: "rotation",
  CHAIN_RESTART: "chain-restart",
} as const;

export type StatementOp = (typeof STATEMENT_OP)[keyof typeof STATEMENT_OP];

export class InvalidArtifactKeyError extends Error {
  readonly code = "INVALID_ARTIFACT_KEY";
  constructor() {
    super("not an audit anchor artifact key");
    this.name = "InvalidArtifactKeyError";
  }
}

const KID_SOURCE = `${AUDIT_ANCHOR_KID_PREFIX}[0-9a-f]{${AUDIT_ANCHOR_KID_HEX_CHARS}}`;
const KID_RE = new RegExp(`^${KID_SOURCE}$`);
const MANIFEST_KEY_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.kid-(${KID_SOURCE})\\.jws$`);
const PUBLIC_KEY_KEY_RE = new RegExp(`^public-keys/${KID_SOURCE}\\.pub$`);
const STATEMENT_KEY_RE = new RegExp(
  `^key-rotation-(\\d{4})(\\d{2})(\\d{2})\\.(?:${Object.values(STATEMENT_OP).join("|")})\\.kid-${KID_SOURCE}\\.jws$`,
);

/** Whether `kid` is the shape a public key derives: the prefix and 16 lower-case hex chars. */
export function isAnchorKid(kid: unknown): kid is string {
  return typeof kid === "string" && KID_RE.test(kid);
}

function assertKid(kid: string): void {
  if (!isAnchorKid(kid)) throw new InvalidArtifactKeyError();
}

/** `date` (YYYY-MM-DD) names a real UTC day. */
function isCalendarDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) && utcDate(new Date(ms)) === date;
}

function utcDate(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** The manifest's key, `YYYY-MM-DD.kid-<kid>.jws`, dated by the boundary's UTC day. */
export function buildManifestArtifactKey(boundary: Date, kid: string): string {
  assertKid(kid);
  return `${utcDate(boundary)}.kid-${kid}.jws`;
}

export function parseManifestArtifactKey(key: string): { date: string; kid: string } | null {
  const match = MANIFEST_KEY_RE.exec(key);
  if (!match || !isCalendarDate(match[1])) return null;
  return { date: match[1], kid: match[2] };
}

/** The archived public key of `kid`, `public-keys/<kid>.pub`. */
export function publicKeyArtifactKey(kid: string): string {
  assertKid(kid);
  return `public-keys/${kid}.pub`;
}

/** A signed operator statement, `key-rotation-YYYYMMDD.<op>.kid-<signer kid>.jws`. */
export function statementArtifactKey(day: Date, op: StatementOp, signerKid: string): string {
  assertKid(signerKid);
  return `key-rotation-${utcDate(day).replaceAll("-", "")}.${op}.kid-${signerKid}.jws`;
}

function isStatementArtifactKey(key: string): boolean {
  const match = STATEMENT_KEY_RE.exec(key);
  return match !== null && isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
}

/** Whether `key` is one of the three shapes. */
export function isAnchorArtifactKey(key: string): boolean {
  return parseManifestArtifactKey(key) !== null || PUBLIC_KEY_KEY_RE.test(key) || isStatementArtifactKey(key);
}

/** Throws InvalidArtifactKeyError unless `key` is one of the three shapes. */
export function assertAnchorArtifactKey(key: string): void {
  if (!isAnchorArtifactKey(key)) throw new InvalidArtifactKeyError();
}
