/**
 * Interactive .env.local generator.
 *
 * Prompts for every env var declared in the Zod schema, writes a valid
 * .env.local atomically (mode 0o600), and validates the result before
 * committing the rename.
 *
 * Usage: tsx scripts/init-env.ts [--profile=dev|ci|production]
 *                                [--print-secrets]
 *                                [--abort-on-missing]
 *
 * Exports run(opts) for programmatic testing (T4).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { envObject, envSchema } from "@/lib/env-schema";
import { descriptions, GROUPS } from "./env-descriptions";
import { createPrompter } from "./lib/prompt";

// ─── Types ───────────────────────────────────────────────────────────────────

type Profile = "dev" | "ci" | "production";

type FieldMeta = {
  key: string;
  groupIndex: number;
  order: number;
  isSecret: boolean;
};

// Track how each value was sourced for the final summary.
type ValueSource = "generated" | "profile" | "user";

// ─── CI profile defaults (mirrors .github/workflows/ci.yml) ─────────────────

const CI_DEFAULTS: Partial<Record<string, string>> = {
  DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci",
  SHARE_MASTER_KEY:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  AUTH_SECRET: "ci-secret-value-that-is-at-least-32-chars",
  AUTH_URL: "http://localhost:3000",
  VERIFIER_PEPPER_KEY:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  REDIS_URL: "redis://localhost:6379",
};

// Dev profile defaults for fields that have no Zod default but are required.
const DEV_DEFAULTS: Partial<Record<string, string>> = {
  DATABASE_URL: "postgresql://passwd_app:passwd_app@localhost:5432/passwd_sso",
  AUTH_URL: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** SEC-2: reject control characters that would corrupt dotenv format. */
function validateInputValue(value: string): boolean {
  return !value.includes("\n") && !value.includes("\r") && !value.includes("\x00");
}

/**
 * Dotenv-compatible double-quote escaping.
 * Escapes: " \ \n \r $ in values; always wraps in double quotes.
 */
function dotenvEscape(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$/g, "\\$");
  return `"${escaped}"`;
}

/** Format UTC datetime as YYYYMMDD-HHMMSS for backup filenames. */
function formatBackupTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** Atomic write: open with "wx" (fails on EEXIST), write, fsync, close, rename. */
async function atomicWrite(
  targetPath: string,
  content: string,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp`;

  let fd: fs.FileHandle | null = null;
  try {
    fd = await fs.open(tmpPath, "wx", 0o600);
    await fd.write(content);
    // Defensive: re-apply mode in case umask widened it.
    await fd.chmod(0o600);
    await fd.sync();
    await fd.close();
    fd = null;
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    if (fd) {
      await fd.close().catch(() => {});
    }
    // Best-effort cleanup
    await fs.unlink(tmpPath).catch(() => {});

    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      stderr.write(
        `ERROR: ${tmpPath} already exists.\n` +
          `Another init-env is running or crashed; delete ${tmpPath} and retry.\n`,
      );
    }
    throw err;
  }
}

// ─── Ordered field list ───────────────────────────────────────────────────────

type FieldDef = FieldMeta & { hasZodDefault: boolean };

// Zod 4 _def introspection helpers (matches generate-env-example.ts pattern).
type ZodDefNode = {
  type?: string;
  defaultValue?: unknown;
  innerType?: ZodDefNode;
  in?: { _def: ZodDefNode };
};

function hasDefault(def: ZodDefNode): boolean {
  if (!def) return false;
  if (def.type === "default") return true;
  if (def.type === "pipe" && def.in) return hasDefault(def.in._def);
  if (def.type === "optional" && def.innerType) return hasDefault(def.innerType);
  return false;
}

function extractDefault(def: ZodDefNode): string | undefined {
  if (!def) return undefined;
  if (def.type === "default") {
    const v = def.defaultValue;
    if (typeof v === "function") {
      const result = (v as () => unknown)();
      return result !== undefined && result !== null ? String(result) : undefined;
    }
    return v !== undefined && v !== null ? String(v) : undefined;
  }
  if (def.type === "pipe" && def.in) return extractDefault(def.in._def);
  if (def.type === "optional" && def.innerType) return extractDefault(def.innerType);
  return undefined;
}

function buildSortedFields(): FieldDef[] {
  const shape = envObject.shape as Record<string, { _def: ZodDefNode }>;

  return Object.keys(descriptions)
    .map((key): FieldDef => {
      const sidecar = descriptions[key as keyof typeof descriptions];
      const fieldSchema = shape[key];
      return {
        key,
        groupIndex: GROUPS.indexOf(sidecar.group),
        order: sidecar.order,
        isSecret: sidecar.secret === true,
        hasZodDefault: fieldSchema ? hasDefault(fieldSchema._def) : false,
      };
    })
    .sort((a, b) => {
      if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
      return a.order - b.order;
    });
}

// ─── Prompt ordering ──────────────────────────────────────────────────────────

/**
 * Returns fields in prompt order (F24):
 *   Tier 1 — required unconditionally (no Zod default, not optional)
 *   Tier 2 — conditionally required based on current collected values
 *   Tier 3 — everything else (optional / has default)
 * Within each tier: (groupIndex, order).
 *
 * isConditionallyRequired is re-evaluated at call time so prompts for
 * conditionally-required fields appear right after the governing field.
 */
function getPromptTier(
  field: FieldDef,
  collected: Map<string, string>,
): 0 | 1 | 2 {
  const key = field.key;

  // Tier 0 — always required, no Zod default.
  const alwaysRequired: ReadonlySet<string> = new Set([
    "DATABASE_URL",
    "AUTH_SECRET",
    "AUTH_URL",
    "VERIFIER_PEPPER_KEY",
    "SHARE_MASTER_KEY",
    "REDIS_URL",
  ]);
  if (alwaysRequired.has(key) && !field.hasZodDefault) return 0;

  // Tier 1 — conditionally required.
  const emailProvider = collected.get("EMAIL_PROVIDER");
  const keyProvider = collected.get("KEY_PROVIDER");
  const redisSentinel = collected.get("REDIS_SENTINEL");

  if (key === "SMTP_HOST" && emailProvider === "smtp") return 1;
  if (key === "RESEND_API_KEY" && emailProvider === "resend") return 1;
  if (key === "AZURE_KV_URL" && keyProvider === "azure-kv") return 1;
  if (key === "GCP_PROJECT_ID" && keyProvider === "gcp-sm") return 1;
  if (key === "REDIS_SENTINEL_HOSTS" && redisSentinel === "true") return 1;

  return 2;
}

// ─── run() ────────────────────────────────────────────────────────────────────

export type RunOptions = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  now: () => Date;
  args: readonly string[];
};

export async function run(opts: RunOptions): Promise<number> {
  const { stdin, stdout, stderr, now, args } = opts;

  // ── Parse args ─────────────────────────────────────────────────────────────

  const printSecrets = args.includes("--print-secrets");
  const nonInteractive = args.includes("--non-interactive");
  const abortOnMissing = args.includes("--abort-on-missing");

  const profileArg = args.find((a) => a.startsWith("--profile="));
  const profile: Profile = (profileArg?.split("=")[1] as Profile) ?? "dev";

  if (!["dev", "ci", "production"].includes(profile)) {
    stderr.write(
      `ERROR: --profile must be one of: dev, ci, production (got "${profile}")\n`,
    );
    return 1;
  }

  // S8: --print-secrets + --non-interactive are mutually exclusive.
  if (printSecrets && nonInteractive) {
    stderr.write(
      "ERROR: --print-secrets and --non-interactive are mutually exclusive.\n",
    );
    return 1;
  }

  // --non-interactive is reserved but not implemented.
  if (nonInteractive) {
    stderr.write('ERROR: --non-interactive is not implemented in this PR.\n');
    return 1;
  }

  // ── Platform warning ───────────────────────────────────────────────────────

  if (process.platform === "win32") {
    stderr.write(
      "Warning: file permission cannot be restricted on this platform. " +
        "Treat .env.local as sensitive.\n",
    );
  }

  // ── NF-4.7: git tracked-file safety check ─────────────────────────────────

  // Scripts are run from the repo root via `npm run init:env` (process.cwd()).
  const repoRoot = process.cwd();
  const envLocalPath = path.join(repoRoot, ".env.local");

  const gitResult = spawnSync("git", ["status", "--porcelain", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (gitResult.status === 0 && gitResult.stdout) {
    // NUL-separated entries, each in format "XY path" or "XY old\0new".
    const entries = gitResult.stdout.split("\0").filter(Boolean);
    const trackedStatusCodes = new Set(["M", "A", "R", "C"]);
    const targetNames = [".env.local", ".env.local.tmp"];

    for (const entry of entries) {
      // First two chars are XY status codes; rest is path (after a space).
      if (entry.length < 3) continue;
      const indexCode = entry[0];
      const entryPath = entry.slice(3);
      const basename = path.basename(entryPath);

      if (targetNames.includes(basename) && trackedStatusCodes.has(indexCode)) {
        stderr.write(
          `ERROR: Refusing to write: target path ${entryPath} is tracked by git ` +
            `(status: ${indexCode}). Run 'git rm --cached ${entryPath}' to untrack ` +
            `before re-running. Gitignored-but-untracked paths are fine.\n`,
        );
        return 1;
      }
    }
  }

  // ── Check for existing .env.local ─────────────────────────────────────────

  const prompter = createPrompter({ stdin, stdout, stderr });

  let envLocalExists = false;
  try {
    await fs.access(envLocalPath);
    envLocalExists = true;
  } catch {
    envLocalExists = false;
  }

  if (envLocalExists) {
    const action = await prompter.askChoice(
      ".env.local already exists. What would you like to do?",
      ["Overwrite", "Backup-and-overwrite", "Abort"] as const,
    );

    if (action === "Abort") {
      stdout.write("Aborted. No changes made.\n");
      prompter.close();
      return 0;
    }

    if (action === "Backup-and-overwrite") {
      const stamp = formatBackupTimestamp(now());
      const backupPath = path.join(repoRoot, `.env.local.bak-${stamp}`);

      if (process.platform === "win32") {
        stderr.write(
          "Warning: file permission cannot be restricted on this platform. " +
            "Treat .env.local as sensitive.\n",
        );
      }

      const existing = await fs.readFile(envLocalPath, "utf8");
      await atomicWrite(backupPath, existing, stderr);
      stdout.write(`Backed up to ${backupPath}\n`);
    }
    // "Overwrite" falls through — we'll overwrite in the write step.
  }

  // ── Build sorted field list ────────────────────────────────────────────────

  const allFields = buildSortedFields();
  const shape = envObject.shape as Record<string, { _def: ZodDefNode }>;

  // collected: key → raw string value (before any coercion).
  const collected = new Map<string, string>();
  // sources: key → how the value was obtained.
  const sources = new Map<string, ValueSource>();

  // Seed profile defaults so conditional tiers resolve correctly early.
  if (profile === "ci") {
    for (const [k, v] of Object.entries(CI_DEFAULTS)) {
      collected.set(k, v!);
      sources.set(k, "profile");
    }
  } else if (profile === "dev") {
    for (const [k, v] of Object.entries(DEV_DEFAULTS)) {
      collected.set(k, v!);
      sources.set(k, "profile");
    }
    // Also seed Zod defaults for dev.
    for (const field of allFields) {
      if (!collected.has(field.key)) {
        const fieldSchema = shape[field.key];
        if (fieldSchema && hasDefault(fieldSchema._def)) {
          const defVal = extractDefault(fieldSchema._def);
          if (defVal !== undefined) {
            collected.set(field.key, defVal);
            sources.set(field.key, "profile");
          }
        }
      }
    }
  }

  // ── Prompt loop (sorted by tier then group/order) ──────────────────────────

  // We do two passes: first collect, then re-validate and re-prompt on errors.
  // The prompt ordering re-evaluates tiers dynamically as answers accumulate.

  // Sort fields into prompt order: sort by tier first, then groupIndex, order.
  // Because tier depends on collected values, we run a stable multi-pass sort.
  const promptFields = [...allFields].sort((a, b) => {
    const ta = getPromptTier(a, collected);
    const tb = getPromptTier(b, collected);
    if (ta !== tb) return ta - tb;
    if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
    return a.order - b.order;
  });

  for (const field of promptFields) {
    const { key, isSecret } = field;
    const sidecar = descriptions[key as keyof typeof descriptions];
    const existing = collected.get(key);

    // For ci profile: values already seeded, skip prompting.
    if (profile === "ci" && sources.get(key) === "profile") {
      continue;
    }

    // For dev/production: check if we already have a usable value.
    if (profile === "dev" && existing !== undefined && !isSecret) {
      // Keep dev defaults for non-secret fields without prompting.
      continue;
    }

    // Show field info.
    stdout.write(`\n--- ${key} ---\n`);
    if (sidecar.description) {
      for (const line of sidecar.description.split("\n")) {
        stdout.write(`  ${line}\n`);
      }
    }

    const exampleHint = sidecar.example;

    // For secret fields: offer to generate.
    if (isSecret) {
      const generate = await prompter.askYesNo(
        `Generate a random value for ${key}?`,
        true,
      );
      if (generate) {
        const generated = crypto.randomBytes(32).toString("hex");
        collected.set(key, generated);
        sources.set(key, "generated");
        stdout.write(
          printSecrets
            ? `  Generated: ${generated}\n`
            : `  Generated: [generated]\n`,
        );
        continue;
      }
    }

    // Prompt for value.
    const defaultValue = existing ?? exampleHint;
    let accepted: string | undefined;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      const answer = await prompter.ask(
        `Enter value for ${key}`,
        { defaultValue, secret: isSecret },
      );

      // SEC-2: reject unsafe characters.
      if (!validateInputValue(answer)) {
        stderr.write(
          `  ERROR: value contains illegal characters (\\n, \\r, or \\x00). ` +
            `Please try again.\n`,
        );
        attempts++;
        continue;
      }

      accepted = answer;
      break;
    }

    if (accepted === undefined) {
      stderr.write(
        `ERROR: Failed to get a valid value for ${key} after ${maxAttempts} attempts.\n`,
      );
      if (abortOnMissing) {
        prompter.close();
        return 1;
      }
      // Leave field unset — will be caught by Zod validation below.
    } else {
      collected.set(key, accepted);
      sources.set(key, "user");
    }
  }

  // ── Validate collected values ──────────────────────────────────────────────

  // Build object for Zod validation (use raw strings — Zod coerces).
  const rawObj: Record<string, string> = {};
  for (const [k, v] of collected) {
    rawObj[k] = v;
  }

  // Use the refined schema for final validation.
  const MAX_FIELD_ATTEMPTS = 5;
  const failedFields: string[] = [];

  const validationResult = envSchema.safeParse(rawObj);

  if (!validationResult.success) {
    // Collect failing paths.
    const failingPaths = new Set(
      validationResult.error.issues.map((i) => String(i.path[0] ?? "")),
    );

    // Re-prompt failing fields using the same prompter (max 5 attempts each).
    for (const fieldPath of failingPaths) {
      if (!fieldPath) continue;

      const sidecar = descriptions[fieldPath as keyof typeof descriptions];
      if (!sidecar) continue;
      const isSecret = sidecar.secret === true;

      let resolved = false;

      // CS2: track which issues to show on the NEXT iteration. Starts with the
      // initial validation failure; replaced after each retry with the fresh
      // testResult issues so the user sees the error for the value they just
      // typed, not the stale original message.
      let currentIssues = validationResult.error.issues.filter(
        (i) => String(i.path[0]) === fieldPath,
      );

      for (let attempt = 0; attempt < MAX_FIELD_ATTEMPTS; attempt++) {
        // Show errors — path + message only, NEVER the rejected value (NF-4.3).
        stderr.write(`\nValidation error for ${fieldPath}:\n`);
        for (const issue of currentIssues) {
          stderr.write(`  ${issue.message}\n`);
        }

        let answer: string;
        if (isSecret) {
          const gen = await prompter.askYesNo(
            `Generate a new value for ${fieldPath}?`,
            true,
          );
          if (gen) {
            answer = crypto.randomBytes(32).toString("hex");
          } else {
            answer = await prompter.ask(`Re-enter ${fieldPath}`, { secret: true });
          }
        } else {
          answer = await prompter.ask(`Re-enter ${fieldPath}`);
        }

        if (!validateInputValue(answer)) {
          stderr.write(`  ERROR: value contains illegal characters. Try again.\n`);
          continue;
        }

        // Test if the field now passes.
        const testObj = { ...rawObj, [fieldPath]: answer };
        const testResult = envSchema.safeParse(testObj);
        const stillFailing = testResult.success
          ? false
          : testResult.error.issues.some((i) => String(i.path[0]) === fieldPath);

        if (!stillFailing) {
          rawObj[fieldPath] = answer;
          collected.set(fieldPath, answer);
          sources.set(fieldPath, "user");
          resolved = true;
          break;
        }

        // Refresh issues from the latest testResult so the next iteration
        // displays the CURRENT failure's message (CS2), not the stale initial one.
        currentIssues = testResult.success
          ? []
          : testResult.error.issues.filter(
              (i) => String(i.path[0]) === fieldPath,
            );
      }

      if (!resolved) {
        failedFields.push(fieldPath);
      }
    }

    if (failedFields.length > 0) {
      prompter.close();
      stderr.write(
        `\nERROR: The following fields failed validation after ${MAX_FIELD_ATTEMPTS} attempts:\n`,
      );
      for (const f of failedFields) {
        stderr.write(`  - ${f}\n`);
      }
      return 1;
    }
  }

  prompter.close();

  // ── Build .env.local content ───────────────────────────────────────────────

  // Write order: pure sidecar (group, order) — NF-3 determinism.
  const writeFields = buildSortedFields();

  const lines: string[] = [
    "# Generated by npm run init:env",
    `# Profile: ${profile}`,
    `# Generated at: ${now().toISOString()}`,
    "",
  ];

  let currentGroupIndex = -1;

  // NF-4.6 / S16: same hex32+ emit-time guard as generate-env-example.ts.
  // A value matching /^[A-Fa-f0-9]{32,}$/ on a non-secret field indicates a
  // sidecar bug (either the field should be marked secret, or the example
  // should not look like a hex secret). Fail closed before writing.
  const HEX32_RE = /^[A-Fa-f0-9]{32,}$/;

  for (const field of writeFields) {
    const { key, groupIndex } = field;
    const value = collected.get(key);
    if (value === undefined) continue;

    const sidecar = descriptions[key as keyof typeof descriptions];

    if (HEX32_RE.test(value) && !sidecar.secret) {
      stderr.write(
        `ERROR: refusing to write .env.local — key "${key}" has a value ` +
          `matching /^[A-Fa-f0-9]{32,}$/ but its sidecar entry is not marked ` +
          `secret: true. This is a sidecar bug (see NF-4.6/S16). Fix the ` +
          `sidecar and re-run.\n`,
      );
      return 1;
    }

    if (groupIndex !== currentGroupIndex) {
      if (lines.length > 1) lines.push("");
      lines.push(`# --- ${GROUPS[groupIndex]} ---`);
      lines.push("");
      currentGroupIndex = groupIndex;
    }

    // Description as comments.
    for (const descLine of sidecar.description.split("\n")) {
      lines.push(`# ${descLine}`);
    }

    lines.push(`${key}=${dotenvEscape(value)}`);
    lines.push("");
  }

  const content = lines.join("\n") + "\n";

  // ── Atomic write ──────────────────────────────────────────────────────────

  if (process.platform === "win32") {
    stderr.write(
      "Warning: file permission cannot be restricted on this platform. " +
        "Treat .env.local as sensitive.\n",
    );
  }

  try {
    await atomicWrite(envLocalPath, content, stderr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`ERROR: Failed to write .env.local: ${msg}\n`);
    return 1;
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  let nGenerated = 0;
  let nProfile = 0;
  let nUser = 0;

  for (const [key] of collected) {
    // Only count fields that ended up in the file.
    if (!writeFields.some((f) => f.key === key)) continue;
    const src = sources.get(key);
    if (src === "generated") nGenerated++;
    else if (src === "profile") nProfile++;
    else nUser++;
  }

  const total = nGenerated + nProfile + nUser;
  stdout.write(
    `\nwrote .env.local: ${total} vars ` +
      `(${nGenerated} generated, ${nProfile} from profile, ${nUser} user-entered).\n`,
  );

  return 0;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  run({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => new Date(),
    args: process.argv.slice(2),
  }).then((code) => process.exit(code));
}
