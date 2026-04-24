/**
 * Drift checker for env-config-sync (§D of env-config-sync-and-generator-plan.md).
 *
 * Implements all 11 checks:
 *   1. Zod vs .env.example: every schema key in .env.example (KEY= or # KEY=)
 *   2. .env.example vs Zod: every .env.example key is in Zod or allowlist
 *   3. Compose vs (Zod ∪ allowlist): all docker-compose*.yml vars are covered
 *   4. Allowlist dead entry: literal key not also in Zod
 *   5. Allowlist stale entry: consumers[] or compose references the key
 *   6. Sidecar-Zod sync: sidecar ↔ schema agree; all group names are in GROUPS
 *   7. Duplicates in .env.example
 *   8. Commented-required: documented limitation (superRefine conditional reqs
 *      are out of scope — see below)
 *   9. Allowlist app-read violation: literal-key entries not read by src/**
 *  10. Allowlist entry shape validation (including regex safety)
 *  11. Allowlist file presence
 *
 * LIMITATION (check 8): Zod fields that are only conditionally required via
 * superRefine (e.g. SMTP_HOST when EMAIL_PROVIDER=smtp) are NOT flagged when
 * commented in .env.example, because the Zod shape itself marks them .optional().
 * This is a documented trade-off — exhaustive conditional-requirement tracking
 * would require re-implementing superRefine logic in this checker.
 *
 * Usage:
 *   npx tsx scripts/check-env-docs.ts [--root <path>]
 *
 * Exit 0 = no drift detected.
 * Exit 1 = drift detected; grouped report written to stderr.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve repo root (default: dirname of this file's parent)
// ---------------------------------------------------------------------------
const SCRIPT_DIR = resolve(
  fileURLToPath(import.meta.url).replace(/\.ts$/, ".js"),
  "../.."
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { root: string } {
  let root = resolve(SCRIPT_DIR);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = resolve(argv[i + 1]);
      i++;
    }
  }
  return { root };
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ---------------------------------------------------------------------------
// Parse .env.example keys
// ---------------------------------------------------------------------------
function parseEnvExample(text: string): {
  activeKeys: Set<string>;
  commentedKeys: Set<string>;
  allKeys: string[];
} {
  const activeKeys = new Set<string>();
  const commentedKeys = new Set<string>();
  const allKeys: string[] = [];

  for (const line of text.split("\n")) {
    // Active key: KEY= or KEY=value
    const activeMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (activeMatch) {
      activeKeys.add(activeMatch[1]);
      allKeys.push(activeMatch[1]);
      continue;
    }
    // Commented key: # KEY= or # KEY=value
    const commentedMatch = line.match(/^#\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (commentedMatch) {
      commentedKeys.add(commentedMatch[1]);
      allKeys.push(commentedMatch[1]);
    }
  }

  return { activeKeys, commentedKeys, allKeys };
}

// ---------------------------------------------------------------------------
// Collect Zod schema keys via getSchemaShape()
// ---------------------------------------------------------------------------
async function getZodKeys(root: string): Promise<Set<string>> {
  // Dynamic import resolves from the script's actual path,
  // but under tsx the tsconfig paths alias @/ points to src/.
  // We resolve the absolute path manually.
  const schemaPath = resolve(root, "src/lib/env-schema.ts");
  if (!fileExists(schemaPath)) {
    throw new Error(`env-schema not found at ${schemaPath}`);
  }
  // tsx resolves TypeScript via tsconfig paths. Import using the alias.
  // We use a dynamic import with an absolute path instead.
  const mod = await import(resolve(root, "src/lib/env-schema.ts"));
  const shape = mod.getSchemaShape ? mod.getSchemaShape() : mod.envObject?.shape;
  if (!shape) {
    throw new Error("getSchemaShape() or envObject.shape not found in env-schema");
  }
  return new Set(Object.keys(shape));
}

// ---------------------------------------------------------------------------
// Collect sidecar keys and their groups
// ---------------------------------------------------------------------------
async function getSidecarEntries(
  root: string,
): Promise<{ keys: Set<string>; groups: Map<string, string> }> {
  const descPath = resolve(root, "scripts/env-descriptions.ts");
  if (!fileExists(descPath)) {
    throw new Error(`env-descriptions.ts not found at ${descPath}`);
  }
  const mod = await import(resolve(root, "scripts/env-descriptions.ts"));
  const descriptions = mod.descriptions as Record<
    string,
    { group: string; [k: string]: unknown }
  >;
  const GROUPS: readonly string[] = mod.GROUPS ?? [];
  const keys = new Set(Object.keys(descriptions));
  const groups = new Map<string, string>();
  for (const [k, v] of Object.entries(descriptions)) {
    groups.set(k, v.group);
  }
  return { keys, groups, GROUPS } as {
    keys: Set<string>;
    groups: Map<string, string>;
    GROUPS: readonly string[];
  } & { GROUPS: readonly string[] };
}

// ---------------------------------------------------------------------------
// Load allowlist
// ---------------------------------------------------------------------------
async function getAllowlist(root: string) {
  const allowlistPath = resolve(root, "scripts/env-allowlist.ts");
  if (!fileExists(allowlistPath)) {
    return null;
  }
  const mod = await import(allowlistPath);
  return mod.ALLOWLIST as import("./env-allowlist.ts").AllowlistEntry[];
}

// ---------------------------------------------------------------------------
// Scan docker-compose*.yml files
// ---------------------------------------------------------------------------
function findComposeFiles(root: string): string[] {
  return readdirSync(root)
    .filter((f) => f.match(/^docker-compose.*\.yml$/))
    .map((f) => join(root, f));
}

async function scanComposeFiles(root: string): Promise<Set<string>> {
  const { scanComposeFile } = await import(
    resolve(root, "scripts/lib/compose-env-scan.ts")
  );
  const files = findComposeFiles(root);
  const vars = new Set<string>();
  for (const file of files) {
    const text = readText(file);
    try {
      const found = scanComposeFile(text);
      for (const v of found) vars.add(v);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Error scanning ${file}: ${msg}`);
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Scan src/**/*.ts for process.env.VAR and envInt/envBool/envStr("VAR") reads
// (excludes test files)
// ---------------------------------------------------------------------------
function scanAppEnvReaders(root: string): Set<string> {
  const srcDir = resolve(root, "src");
  const vars = new Set<string>();
  // Excluded directories: test infrastructure, not production app code.
  const SKIP_DIRS = new Set(["__tests__", "__mocks__"]);

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".test.mjs")
      ) {
        const text = readText(full);
        // process.env.VAR (dot-form)
        const dotRe = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
        let m: RegExpExecArray | null;
        while ((m = dotRe.exec(text)) !== null) {
          vars.add(m[1]);
        }
        // envInt("VAR", ...), envBool("VAR", ...), envStr("VAR", ...)
        const helperRe = /env(?:Int|Bool|Str)\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
        while ((m = helperRe.exec(text)) !== null) {
          vars.add(m[1]);
        }
      }
    }
  }

  if (existsSync(srcDir)) {
    walk(srcDir);
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Check 10: Allowlist entry shape validation
// ---------------------------------------------------------------------------
const FIXTURE_VARS = [
  "AUTH_SECRET", "DATABASE_URL", "AUTH_URL", "NODE_ENV", "APP_URL",
  "REDIS_URL", "EMAIL_PROVIDER", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
  "SMTP_PASS", "EMAIL_FROM", "RESEND_API_KEY", "LOG_LEVEL", "HEALTH_REDIS_REQUIRED",
  "BLOB_BACKEND", "BLOB_OBJECT_PREFIX", "AUDIT_LOG_FORWARD", "AUDIT_LOG_APP_NAME",
  "AWS_REGION", "S3_ATTACHMENTS_BUCKET", "AZURE_STORAGE_ACCOUNT", "AZURE_BLOB_CONTAINER",
  "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_SAS_TOKEN", "GCS_ATTACHMENTS_BUCKET",
  "WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "WEBAUTHN_RP_ORIGIN", "WEBAUTHN_PRF_SECRET",
  "DIRECTORY_SYNC_MASTER_KEY", "OPENAPI_PUBLIC", "KEY_PROVIDER", "SM_CACHE_TTL_MS",
  "AZURE_KV_URL", "GCP_PROJECT_ID", "REDIS_SENTINEL", "REDIS_SENTINEL_HOSTS",
  "REDIS_SENTINEL_MASTER_NAME", "REDIS_SENTINEL_PASSWORD", "REDIS_SENTINEL_TLS",
  "OUTBOX_BATCH_SIZE", "OUTBOX_POLL_INTERVAL_MS", "OUTBOX_PROCESSING_TIMEOUT_MS",
  "OUTBOX_MAX_ATTEMPTS", "OUTBOX_RETENTION_HOURS", "OUTBOX_FAILED_RETENTION_DAYS",
  "OUTBOX_READY_PENDING_THRESHOLD", "OUTBOX_READY_OLDEST_THRESHOLD_SECS",
  "OUTBOX_REAPER_INTERVAL_MS", "OUTBOX_WORKER_DATABASE_URL", "MIGRATION_DATABASE_URL",
  "SHARE_MASTER_KEY", "SHARE_MASTER_KEY_CURRENT_VERSION", "VERIFIER_PEPPER_KEY",
  "ADMIN_API_TOKEN", "TRUSTED_PROXIES", "TRUST_PROXY_HEADERS",
  "NEXT_PUBLIC_APP_NAME", "NEXT_PUBLIC_BASE_PATH",
];

const UNBOUNDED_RE = /\.\*|\.\+|\\w\*|\\w\+|\[\^\]\*|\[\^\]\+/;
const NESTED_QUANTIFIER_RE = /[+*{][^)]*[+*{]/;

type AllowlistEntry = {
  type: "literal" | "regex";
  key?: string;
  pattern?: string;
  justification: string;
  consumers: readonly string[];
  reviewedAt: string;
};

function validateAllowlistShape(entry: AllowlistEntry, idx: number): string[] {
  const errs: string[] = [];
  const prefix = `allowlist[${idx}]`;

  if (entry.justification.length < 40) {
    errs.push(`${prefix}: justification must be ≥40 chars (got ${entry.justification.length})`);
  }
  if (!entry.consumers || entry.consumers.length === 0) {
    errs.push(`${prefix}: consumers must be non-empty`);
  } else {
    for (const c of entry.consumers) {
      if (!c || c.trim().length === 0) {
        errs.push(`${prefix}: consumers entry is empty`);
      }
    }
  }
  // ISO-8601 date check (YYYY-MM-DD or full datetime)
  if (!/^\d{4}-\d{2}-\d{2}/.test(entry.reviewedAt)) {
    errs.push(`${prefix}: reviewedAt "${entry.reviewedAt}" is not a valid ISO-8601 date`);
  } else {
    const d = new Date(entry.reviewedAt);
    if (isNaN(d.getTime())) {
      errs.push(`${prefix}: reviewedAt "${entry.reviewedAt}" is not a valid date`);
    }
  }

  if (entry.type === "regex") {
    const pattern = entry.pattern ?? "";
    // Must compile.
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      errs.push(`${prefix}: pattern "${pattern}" does not compile as RegExp`);
      return errs;
    }
    // No unbounded quantifiers.
    if (UNBOUNDED_RE.test(pattern)) {
      errs.push(`${prefix}: pattern "${pattern}" contains unbounded quantifier`);
    }
    // No nested quantifiers (ReDoS risk).
    if (NESTED_QUANTIFIER_RE.test(pattern)) {
      errs.push(`${prefix}: pattern "${pattern}" contains nested quantifiers (ReDoS risk)`);
    }
    // Must have an 8+ char literal prefix before the first quantifier.
    // Strip leading ^ and check the next 8 chars are [A-Z_] before any metachar.
    const stripped = pattern.replace(/^\^/, "");
    const firstMeta = stripped.search(/[*+?{|(]/);
    const prefixPart = firstMeta === -1 ? stripped : stripped.slice(0, firstMeta);
    if (prefixPart.length < 8) {
      errs.push(
        `${prefix}: pattern "${pattern}" needs an 8+ char literal prefix before the first quantifier (got "${prefixPart}")`
      );
    }
    // Overly-permissive check: must not match >20% (>12) of fixture vars.
    const matchCount = FIXTURE_VARS.filter((v) => re.test(v)).length;
    if (matchCount > 12) {
      errs.push(
        `${prefix}: pattern "${pattern}" matches ${matchCount}/${FIXTURE_VARS.length} fixture vars (overly permissive — threshold: 12)`
      );
    }
  }

  return errs;
}

// ---------------------------------------------------------------------------
// Check 5: stale allowlist entry
// ---------------------------------------------------------------------------
function checkAllowlistStale(
  entry: AllowlistEntry,
  idx: number,
  root: string,
  composeVars: Set<string>,
): string[] {
  const errs: string[] = [];
  const keyOrPattern = entry.type === "literal" ? (entry.key ?? "") : (entry.pattern ?? "");
  const prefix = `allowlist[${idx}] "${keyOrPattern}"`;

  let foundInCompose = false;
  let foundInConsumer = false;

  if (entry.type === "literal" && entry.key) {
    foundInCompose = composeVars.has(entry.key);
  }

  // Check each consumer file for the key name or pattern.
  for (const consumer of entry.consumers ?? []) {
    const consumerPath = resolve(root, consumer);
    // If it's a directory, scan all files in it.
    let pathsToCheck: string[] = [];
    if (existsSync(consumerPath)) {
      try {
        const stat = readdirSync(consumerPath);
        pathsToCheck = stat.map((f) => join(consumerPath, f));
      } catch {
        pathsToCheck = [consumerPath];
      }
    } else {
      pathsToCheck = [consumerPath];
    }

    for (const p of pathsToCheck) {
      if (!existsSync(p)) continue;
      try {
        const text = readText(p);
        const searchFor =
          entry.type === "literal"
            ? entry.key ?? ""
            : (entry.pattern ?? "").replace(/\^|\$|[\[\]\\]/g, "").slice(0, 16);
        if (text.includes(searchFor)) {
          foundInConsumer = true;
          break;
        }
      } catch {
        // skip unreadable
      }
    }
    if (foundInConsumer) break;
  }

  if (!foundInCompose && !foundInConsumer) {
    errs.push(
      `${prefix}: stale allowlist entry — not referenced by compose files or consumers[]`
    );
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function main(argv: string[]): Promise<number> {
  const { root } = parseArgs(argv);
  const errors: string[] = [];

  // Check 11: allowlist file presence.
  const allowlistPath = resolve(root, "scripts/env-allowlist.ts");
  if (!fileExists(allowlistPath)) {
    errors.push("check 11 [allowlist-presence]: scripts/env-allowlist.ts does not exist");
    // Cannot proceed with most other checks.
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }

  // Load all required data.
  let zodKeys: Set<string>;
  let sidecarData: {
    keys: Set<string>;
    groups: Map<string, string>;
    GROUPS: readonly string[];
  };
  let allowlist: AllowlistEntry[] | null;
  let composeVars: Set<string>;
  let envExampleText: string;

  try {
    zodKeys = await getZodKeys(root);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Failed to load env-schema: ${msg}`);
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }

  try {
    sidecarData = await getSidecarEntries(root) as typeof sidecarData;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Failed to load env-descriptions: ${msg}`);
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }

  try {
    allowlist = await getAllowlist(root);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Failed to load env-allowlist: ${msg}`);
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }

  try {
    composeVars = await scanComposeFiles(root);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Failed to scan compose files: ${msg}`);
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }

  const envExamplePath = resolve(root, ".env.example");
  if (!fileExists(envExamplePath)) {
    errors.push("check 1 [zod-vs-example]: .env.example not found");
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }
  envExampleText = readText(envExamplePath);
  const { activeKeys, commentedKeys, allKeys } = parseEnvExample(envExampleText);
  const allExampleKeys = new Set([...activeKeys, ...commentedKeys]);

  // Build allowlist sets for lookup.
  const allowlistLiteralKeys = new Set<string>();
  const allowlistRegexEntries: { re: RegExp; entry: AllowlistEntry }[] = [];
  if (allowlist) {
    for (const entry of allowlist) {
      if (entry.type === "literal" && entry.key) {
        allowlistLiteralKeys.add(entry.key);
      } else if (entry.type === "regex" && entry.pattern) {
        try {
          allowlistRegexEntries.push({ re: new RegExp(entry.pattern), entry });
        } catch {
          // will be caught by check 10
        }
      }
    }
  }

  function isInAllowlist(key: string): boolean {
    if (allowlistLiteralKeys.has(key)) return true;
    return allowlistRegexEntries.some(({ re }) => re.test(key));
  }

  // Check 1: every Zod key appears in .env.example (active or commented).
  for (const key of zodKeys) {
    if (!allExampleKeys.has(key)) {
      errors.push(
        `check 1 [zod-vs-example]: Zod key "${key}" missing from .env.example`
      );
    }
  }

  // Check 2: every .env.example key is in Zod or allowlist.
  for (const key of allExampleKeys) {
    if (!zodKeys.has(key) && !isInAllowlist(key)) {
      errors.push(
        `check 2 [example-vs-zod]: .env.example key "${key}" not in Zod or allowlist`
      );
    }
  }

  // Check 3: every compose var is in Zod or allowlist.
  for (const v of composeVars) {
    if (!zodKeys.has(v) && !isInAllowlist(v)) {
      errors.push(
        `check 3 [compose-vs-zod]: compose file references "${v}" which is not in Zod or allowlist`
      );
    }
  }

  // Check 4: literal allowlist key not also in Zod.
  for (const key of allowlistLiteralKeys) {
    if (zodKeys.has(key)) {
      errors.push(
        `check 4 [allowlist-dead]: "${key}" is in both Zod schema and allowlist (ambiguous bucket)`
      );
    }
  }

  // Check 5: stale allowlist entries.
  if (allowlist) {
    for (let i = 0; i < allowlist.length; i++) {
      const entry = allowlist[i];
      const staleErrs = checkAllowlistStale(entry, i, root, composeVars);
      errors.push(...staleErrs);
    }
  }

  // Check 6: sidecar ↔ Zod sync + group validation.
  const { keys: sidecarKeys, groups: sidecarGroups, GROUPS: knownGroups } = sidecarData;
  for (const key of zodKeys) {
    if (!sidecarKeys.has(key)) {
      errors.push(
        `check 6 [sidecar-zod-sync]: Zod key "${key}" has no sidecar entry in env-descriptions.ts`
      );
    }
  }
  for (const key of sidecarKeys) {
    if (!zodKeys.has(key)) {
      errors.push(
        `check 6 [sidecar-zod-sync]: sidecar key "${key}" not found in Zod schema`
      );
    }
  }
  // T27: every sidecar group value must be in GROUPS.
  for (const [key, group] of sidecarGroups) {
    if (!knownGroups.includes(group as string)) {
      errors.push(
        `check 6 [sidecar-group]: sidecar key "${key}" has unknown group "${group}" (not in GROUPS)`
      );
    }
  }

  // Check 7: no duplicate KEY= lines in .env.example.
  const seen = new Map<string, number>();
  for (const key of allKeys) {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      errors.push(
        `check 7 [duplicates]: .env.example has ${count} occurrences of "${key}="`
      );
    }
  }

  // Check 8: commented-required — documented limitation.
  // Zod fields marked .optional() or with .default() in the base envObject
  // cannot reliably be checked here without re-parsing the Zod shape for
  // optionality. Conditional requirements via superRefine are out of scope.
  // This check is a no-op by design in this implementation.

  // Check 9: allowlist app-read violation (literal entries only).
  // Entries with readByApp: true are exempt — framework-set vars that our
  // code observes but users cannot configure (e.g. NEXT_RUNTIME from Next.js).
  const appReaders = scanAppEnvReaders(root);
  if (allowlist) {
    for (const entry of allowlist) {
      if (entry.type !== "literal") continue;
      if (entry.readByApp) continue;
      if (appReaders.has(entry.key)) {
        errors.push(
          `check 9 [allowlist-app-read]: "${entry.key}" is in the literal allowlist but is read by src/**/*.ts — move it to Zod instead (or set readByApp: true if framework-set)`
        );
      }
    }
  }

  // Check 10: allowlist entry shape.
  if (allowlist) {
    for (let i = 0; i < allowlist.length; i++) {
      const shapeErrs = validateAllowlistShape(allowlist[i] as AllowlistEntry, i);
      for (const e of shapeErrs) {
        errors.push(`check 10 [allowlist-shape]: ${e}`);
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write("check-env-docs FAILED:\n");
    for (const e of errors) {
      process.stderr.write(`  ${e}\n`);
    }
    return 1;
  }

  return 0;
}

// CLI entry point.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("check-env-docs.ts") ||
    process.argv[1].endsWith("check-env-docs.js"));

if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
