#!/usr/bin/env tsx
/**
 * Operator commands for the audit-anchor signing key: print a key's kid,
 * archive its public key, and sign and publish the rotation and chain-restart
 * statements the runbook asks for. Every write is create-only and needs
 * --confirm. No seed is printed, logged or taken from argv: key files only.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "@/lib/load-env";
import {
  STATEMENT_OP,
  publicKeyArtifactKey,
  statementArtifactKey,
  type StatementOp,
} from "@/lib/audit/anchor-artifact-keys";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import { buildDestinationsFromEnv } from "@/lib/audit/anchor-destinations/from-env";
import { jcsCanonical } from "@/lib/audit/audit-chain";
import {
  canonicalize,
  kidForPublicKey,
  parsePublicKeyHex,
  publicKeyForSigningKey,
  readJwsKid,
  signStatement,
  verify,
  verifyStatement,
} from "@/lib/audit/anchor-manifest";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "@/lib/constants/audit/audit";
import { MS_PER_SECOND } from "@/lib/constants/time";

const OPERATION_TIMEOUT_MS = 60 * MS_PER_SECOND;
/** 64 hex chars, a newline, and slack. */
const KEY_FILE_MAX_BYTES = 128;
const PRIVATE_KEY_FILE_MODE = 0o600;
const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

export type KeysDeps = {
  /** Every configured destination, primary first; empty when none is configured. */
  destinations: AnchorDestination[];
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  now: () => Date;
};

/** The operator's arguments are wrong; the message is safe to print. */
class UsageError extends Error {}
/** The command's inputs are well-formed but it refuses; the message is safe to print. */
class RefusedError extends Error {}

type OptionKind = "string" | "boolean";
type Subcommand = {
  usage: string;
  options: Record<string, OptionKind>;
  required: string[];
};

const SUBCOMMANDS = {
  kid: {
    usage: "npm run audit-anchor-kid -- --key-file <path>",
    options: { "key-file": "string" },
    required: ["key-file"],
  },
  "publish-pubkey": {
    usage: "npm run audit-anchor-publish-pubkey -- (--key-file <path> | --public-key <hex>) --confirm",
    options: { "key-file": "string", "public-key": "string", confirm: "boolean" },
    required: [],
  },
  "rotation-statement": {
    usage: "npm run audit-anchor-rotation-statement -- --old-key-file <path> --new-public-key <hex> --out <file>",
    options: { "old-key-file": "string", "new-public-key": "string", out: "string" },
    required: ["old-key-file", "new-public-key", "out"],
  },
  "chain-restart": {
    usage:
      "npm run audit-anchor-chain-restart -- --key-file <path> (--previous-manifest <file> --previous-uri <uri> [--previous-public-key <path>] | --previous-none) --out <file>",
    options: {
      "key-file": "string",
      "previous-manifest": "string",
      "previous-uri": "string",
      "previous-public-key": "string",
      "previous-none": "boolean",
      out: "string",
    },
    required: ["key-file", "out"],
  },
  "publish-statement": {
    usage: "npm run audit-anchor-publish-statement -- --file <file> [--public-key <hex>] --confirm",
    options: { file: "string", "public-key": "string", confirm: "boolean" },
    required: ["file"],
  },
} satisfies Record<string, Subcommand>;

type SubcommandName = keyof typeof SUBCOMMANDS;
type ParsedOptions = Record<string, string | boolean | undefined>;

function isSubcommand(name: string | undefined): name is SubcommandName {
  return name !== undefined && Object.hasOwn(SUBCOMMANDS, name);
}

function parseOptions(name: SubcommandName, args: string[]): ParsedOptions {
  const spec: Subcommand = SUBCOMMANDS[name];
  let values: ParsedOptions;
  try {
    ({ values } = parseArgs({
      args,
      options: Object.fromEntries(Object.entries(spec.options).map(([flag, type]) => [flag, { type }])),
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    // The parser's message quotes the offending token, which could be a seed pasted as an argument.
    throw new UsageError(`invalid arguments (${(err as { code?: string }).code ?? "parse error"})`);
  }
  const missing = spec.required.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((f) => `--${f}`).join(", ")}`);
  return values;
}

function stringOption(values: ParsedOptions, flag: string): string | undefined {
  const value = values[flag];
  return typeof value === "string" ? value : undefined;
}

/**
 * The file's bytes, read through one descriptor so the mode and size checked
 * are those of the bytes read. A private key file must be exactly mode 0600.
 */
function readFileOnce(path: string, opts: { maxBytes: number; privateKey: boolean }): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    throw new RefusedError(`cannot open ${path} (${(err as { code?: string }).code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RefusedError(`${path} is not a regular file`);
    if (opts.privateKey && (st.mode & 0o777) !== PRIVATE_KEY_FILE_MODE) {
      throw new RefusedError(`key file ${path} must be mode 0600`);
    }
    if (st.size > opts.maxBytes) throw new RefusedError(`${path} is larger than ${opts.maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The 32-byte seed in a key file: exactly 64 lower-case hex chars once trimmed. Never echoed. */
function readSeed(path: string): Buffer {
  const hex = readFileOnce(path, { maxBytes: KEY_FILE_MAX_BYTES, privateKey: true }).toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new RefusedError(`key file ${path} must hold exactly 64 lower-case hex chars`);
  return Buffer.from(hex, "hex");
}

function publicKeyFromHex(hex: string): Buffer {
  try {
    return parsePublicKeyHex(hex);
  } catch {
    throw new UsageError("a public key must be exactly 64 lower-case hex chars");
  }
}

function readPublicKeyFile(path: string): Buffer {
  const text = readFileOnce(path, { maxBytes: KEY_FILE_MAX_BYTES, privateKey: false }).toString("utf8");
  try {
    return parsePublicKeyHex(text);
  } catch {
    throw new RefusedError(`public key file ${path} must hold exactly 64 lower-case hex chars`);
  }
}

function readJwsFile(path: string): string {
  return readFileOnce(path, { maxBytes: AUDIT_ANCHOR_ARTIFACT_MAX_BYTES, privateKey: false }).toString("utf8").trim();
}

function writeStatementFile(path: string, jws: string): void {
  try {
    // Create-only: a statement already there is never replaced.
    writeFileSync(path, `${jws}\n`, { flag: "wx", mode: 0o644 });
  } catch (err) {
    throw new RefusedError(`cannot write ${path} (${(err as { code?: string }).code ?? "error"})`);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

/** Prints what is about to be written, refuses without --confirm, then writes create-only everywhere. */
async function publishArtifact(
  deps: KeysDeps,
  values: ParsedOptions,
  artifact: { artifactKey: string; bytes: Buffer; contentType: string; summary: string[] },
): Promise<number> {
  if (deps.destinations.length === 0) {
    throw new UsageError(
      "no destination configured: set AUDIT_ANCHOR_DESTINATION_S3_BUCKET, AUDIT_ANCHOR_DESTINATION_GH_REPO or AUDIT_ANCHOR_DESTINATION_FS_PATH",
    );
  }
  const { artifactKey, bytes } = artifact;
  for (const line of artifact.summary) deps.stdout.write(`${line}\n`);
  deps.stdout.write(`artifact=${artifactKey}\n`);
  for (const d of deps.destinations) deps.stdout.write(`destination=${d.name}\n`);
  if (values.confirm !== true) {
    deps.stderr.write("refusing: the write is create-only and cannot be undone; pass --confirm to proceed\n");
    return EXIT.USAGE;
  }

  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  const different = (d: AnchorDestination) =>
    new RefusedError(`${d.name} already holds a different object at ${artifactKey}`);
  // Check every destination before the first write, so a conflict leaves nothing half-published.
  for (const d of deps.destinations) {
    const stored = await d.read(artifactKey, signal);
    if (stored !== null && !stored.equals(bytes)) throw different(d);
  }
  for (const d of deps.destinations) {
    const result = await d.create({ artifactBytes: bytes, artifactKey, contentType: artifact.contentType, signal });
    if (result === "exists") {
      const stored = await d.read(artifactKey, signal);
      if (stored === null || !stored.equals(bytes)) throw different(d);
    }
    deps.stdout.write(`${d.name}: ${result === "created" ? "created" : "exists (identical)"}\n`);
  }
  return EXIT.OK;
}

async function cmdKid(deps: KeysDeps, values: ParsedOptions): Promise<number> {
  const publicKey = publicKeyForSigningKey(readSeed(stringOption(values, "key-file")!));
  const kid = kidForPublicKey(publicKey);
  deps.stdout.write(`publicKey=${publicKey.toString("hex")}\nkid=${kid}\n`);
  const archiveKey = publicKeyArtifactKey(kid);
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  for (const d of deps.destinations) {
    const stored = await d.read(archiveKey, signal);
    const state = stored === null ? "no" : stored.toString("utf8").trim() === publicKey.toString("hex") ? "yes" : "different";
    deps.stdout.write(`archived[${d.name}]=${state}\n`);
  }
  return EXIT.OK;
}

async function cmdPublishPubkey(deps: KeysDeps, values: ParsedOptions): Promise<number> {
  const keyFile = stringOption(values, "key-file");
  const hex = stringOption(values, "public-key");
  if ((keyFile === undefined) === (hex === undefined)) throw new UsageError("pass exactly one of --key-file and --public-key");
  const publicKey = keyFile !== undefined ? publicKeyForSigningKey(readSeed(keyFile)) : publicKeyFromHex(hex!);
  const kid = kidForPublicKey(publicKey);
  return publishArtifact(deps, values, {
    artifactKey: publicKeyArtifactKey(kid),
    bytes: Buffer.from(`${publicKey.toString("hex")}\n`),
    contentType: "text/plain",
    summary: [`kid=${kid}`, `publicKey=${publicKey.toString("hex")}`],
  });
}

async function cmdRotationStatement(deps: KeysDeps, values: ParsedOptions): Promise<number> {
  const seed = readSeed(stringOption(values, "old-key-file")!);
  const newPublicKey = publicKeyFromHex(stringOption(values, "new-public-key")!);
  const oldKid = kidForPublicKey(publicKeyForSigningKey(seed));
  const newKid = kidForPublicKey(newPublicKey);
  const payload = {
    op: STATEMENT_OP.ROTATION,
    oldKid,
    newKid,
    newPublicKey: newPublicKey.toString("hex"),
    issuedAt: deps.now().toISOString(),
  };
  writeStatementFile(stringOption(values, "out")!, signStatement(Buffer.from(jcsCanonical(payload)), seed));
  deps.stdout.write(`oldKid=${oldKid}\nnewKid=${newKid}\nnewPublicKey=${payload.newPublicKey}\n`);
  return EXIT.OK;
}

async function cmdChainRestart(deps: KeysDeps, values: ParsedOptions): Promise<number> {
  const manifestFile = stringOption(values, "previous-manifest");
  const uri = stringOption(values, "previous-uri");
  const priorKeyFile = stringOption(values, "previous-public-key");
  const none = values["previous-none"] === true;
  if (none ? manifestFile !== undefined || uri !== undefined || priorKeyFile !== undefined : manifestFile === undefined || uri === undefined) {
    throw new UsageError("pass --previous-none, or --previous-manifest with --previous-uri (and optionally --previous-public-key), not both");
  }

  const seed = readSeed(stringOption(values, "key-file")!);
  const ownPublicKey = publicKeyForSigningKey(seed);
  let previousChain: { uri: string; sha256: string } | null = null;
  if (!none) {
    const jws = readJwsFile(manifestFile!);
    let priorKey: Buffer;
    if (priorKeyFile !== undefined) {
      priorKey = readPublicKeyFile(priorKeyFile);
    } else if (readJwsKidOrRefuse(jws) === kidForPublicKey(ownPublicKey)) {
      priorKey = ownPublicKey;
    } else {
      throw new RefusedError("the previous manifest is signed under another key; pass --previous-public-key");
    }
    let manifest;
    try {
      manifest = verify(jws, priorKey);
    } catch (err) {
      throw new RefusedError(`the previous manifest does not verify (${describeError(err)})`);
    }
    previousChain = { uri: uri!, sha256: createHash("sha256").update(canonicalize(manifest)).digest("hex") };
  }

  const payload = { op: STATEMENT_OP.CHAIN_RESTART, previousChain, issuedAt: deps.now().toISOString() };
  writeStatementFile(stringOption(values, "out")!, signStatement(Buffer.from(jcsCanonical(payload)), seed));
  deps.stdout.write(`kid=${kidForPublicKey(ownPublicKey)}\n`);
  deps.stdout.write(previousChain === null ? "previousChain=none\n" : `previousChain=${previousChain.uri} sha256=${previousChain.sha256}\n`);
  return EXIT.OK;
}

function readJwsKidOrRefuse(jws: string): string {
  try {
    return readJwsKid(jws);
  } catch (err) {
    throw new RefusedError(`the previous manifest is not a JWS this tool can read (${err instanceof Error ? err.name : "error"})`);
  }
}

/** The key a statement's header kid names: `--public-key`, else the first archive that holds it. */
async function resolveSignerKey(deps: KeysDeps, kid: string, hex: string | undefined): Promise<Buffer> {
  if (hex !== undefined) return publicKeyFromHex(hex);
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  for (const d of deps.destinations) {
    const stored = await d.read(publicKeyArtifactKey(kid), signal);
    if (stored !== null) {
      try {
        return parsePublicKeyHex(stored.toString("utf8"));
      } catch {
        throw new RefusedError(`${d.name} holds an unreadable public key for ${kid}`);
      }
    }
  }
  throw new RefusedError(`no public key for ${kid}: pass --public-key or archive it first`);
}

function isStatementOp(value: unknown): value is StatementOp {
  return Object.values<unknown>(STATEMENT_OP).includes(value);
}

async function cmdPublishStatement(deps: KeysDeps, values: ParsedOptions): Promise<number> {
  const jws = readJwsFile(stringOption(values, "file")!);
  let kid: string;
  try {
    kid = readJwsKid(jws);
  } catch (err) {
    throw new RefusedError(`not a statement this tool can read (${err instanceof Error ? err.name : "error"})`);
  }
  const publicKey = await resolveSignerKey(deps, kid, stringOption(values, "public-key"));
  let payload: unknown;
  try {
    // Only a signature-checked payload is parsed.
    payload = JSON.parse(verifyStatement(jws, publicKey).toString("utf8"));
  } catch (err) {
    throw new RefusedError(`the statement does not verify (${err instanceof SyntaxError ? "payload is not JSON" : describeError(err)})`);
  }
  const { op, issuedAt } = (payload ?? {}) as { op?: unknown; issuedAt?: unknown };
  const issued = typeof issuedAt === "string" ? new Date(issuedAt) : null;
  if (!isStatementOp(op) || issued === null || Number.isNaN(issued.getTime())) {
    throw new RefusedError("the statement names no known op or issuedAt");
  }
  return publishArtifact(deps, values, {
    artifactKey: statementArtifactKey(issued, op, kid),
    bytes: Buffer.from(jws),
    contentType: "application/jose",
    summary: [`kid=${kid}`, `op=${op}`, `publicKey=${publicKey.toString("hex")}`],
  });
}

const HANDLERS: Record<SubcommandName, (deps: KeysDeps, values: ParsedOptions) => Promise<number>> = {
  kid: cmdKid,
  "publish-pubkey": cmdPublishPubkey,
  "rotation-statement": cmdRotationStatement,
  "chain-restart": cmdChainRestart,
  "publish-statement": cmdPublishStatement,
};

/** Runs one subcommand; returns the process exit code (0 ok, 1 refused or failed, 2 usage). */
export async function run(argv: string[], deps: KeysDeps): Promise<number> {
  const [name, ...rest] = argv;
  if (!isSubcommand(name)) {
    deps.stderr.write(`usage: audit-anchor-keys <${Object.keys(SUBCOMMANDS).join("|")}> ...\n`);
    return EXIT.USAGE;
  }
  try {
    return await HANDLERS[name](deps, parseOptions(name, rest));
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr.write(`${err.message}\nusage: ${SUBCOMMANDS[name].usage}\n`);
      return EXIT.USAGE;
    }
    deps.stderr.write(`${err instanceof RefusedError ? err.message : describeError(err)}\n`);
    return EXIT.FAILED;
  }
}

function destinationsFromProcessEnv(): AnchorDestination[] {
  const configured = [
    "AUDIT_ANCHOR_DESTINATION_S3_BUCKET",
    "AUDIT_ANCHOR_DESTINATION_GH_REPO",
    "AUDIT_ANCHOR_DESTINATION_FS_PATH",
  ].some((name) => process.env[name]);
  if (!configured) return [];
  const env = process.env;
  return buildDestinationsFromEnv({
    AUDIT_ANCHOR_DESTINATION_S3_BUCKET: env.AUDIT_ANCHOR_DESTINATION_S3_BUCKET,
    AUDIT_ANCHOR_DESTINATION_S3_PREFIX: env.AUDIT_ANCHOR_DESTINATION_S3_PREFIX,
    AUDIT_ANCHOR_DESTINATION_GH_REPO: env.AUDIT_ANCHOR_DESTINATION_GH_REPO,
    AUDIT_ANCHOR_DESTINATION_GH_TOKEN: env.AUDIT_ANCHOR_DESTINATION_GH_TOKEN,
    AUDIT_ANCHOR_DESTINATION_FS_PATH: env.AUDIT_ANCHOR_DESTINATION_FS_PATH,
    GITHUB_TOKEN: env.GITHUB_TOKEN,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  loadEnv();
  void (async () => {
    try {
      process.exitCode = await run(process.argv.slice(2), {
        destinations: destinationsFromProcessEnv(),
        stdout: process.stdout,
        stderr: process.stderr,
        now: () => new Date(),
      });
    } catch (err) {
      process.stderr.write(`${describeError(err)}\n`);
      process.exitCode = EXIT.FAILED;
    }
  })();
}
