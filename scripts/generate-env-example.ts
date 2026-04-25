/**
 * Generates .env.example from the Zod schema + sidecar descriptions.
 *
 * Key ordering: sorted by (GROUPS.indexOf(group), order) tuple — never by
 * envObject.shape iteration order (NF-3 determinism requirement).
 *
 * Run: tsx scripts/generate-env-example.ts [--locale=<tag>] [--out=<path>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { envObject } from "@/lib/env-schema";
import { GROUPS, descriptions } from "./env-descriptions";
import { makeEnvKeyCollator } from "./lib/env-sort";
import { ALLOWLIST } from "./env-allowlist";

// ── Arg parsing ───────────────────────────────────────────────────────────

const localeArg = process.argv.find((a) => a.startsWith("--locale="));
const locale = localeArg ? localeArg.split("=")[1] : "en";

// --out=<path>: override the output path. Defaults to ./env.example at cwd.
// Hermetic tests use this to write to a tmp dir instead of the real repo file.
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outPathOverride = outArg ? outArg.split("=")[1] : undefined;

// ── Helpers ───────────────────────────────────────────────────────────────

// Wrap text at maxCols, splitting on spaces. Each resulting line is prefixed
// with "# " in the output. Input is already one logical description string
// that may contain embedded \n for forced line breaks.
function wrapDescriptionLines(text: string, maxCols = 80): string[] {
  const rawLines = text.split("\n");
  const out: string[] = [];
  for (const raw of rawLines) {
    if (raw.length <= maxCols) {
      out.push(raw);
      continue;
    }
    // Soft-wrap at word boundaries.
    const words = raw.split(" ");
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxCols) {
        current += " " + word;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

// Zod 4 uses `type` (not `typeName`) in _def nodes.
type ZodDefNode = {
  type?: string;
  defaultValue?: unknown;
  innerType?: ZodDefNode;
  // ZodPipe has 'in' and 'out'
  in?: { _def: ZodDefNode };
};

// Returns true if the Zod _def chain contains a "default" node anywhere.
function hasDefault(def: ZodDefNode): boolean {
  if (!def) return false;
  if (def.type === "default") return true;
  // ZodPipe — check the input side (e.g. z.coerce.number().default(...))
  if (def.type === "pipe" && def.in) {
    return hasDefault(def.in._def);
  }
  // ZodOptional wraps inner type
  if (def.type === "optional" && def.innerType) {
    return hasDefault(def.innerType);
  }
  return false;
}

// Returns true if the Zod shape for a key has a .default() somewhere in its chain.
function hasZodDefault(_unused: unknown, key: string): boolean {
  const shape = envObject.shape as Record<string, { _def: ZodDefNode }>;
  const fieldSchema = shape[key];
  if (!fieldSchema) return false;
  return hasDefault(fieldSchema._def);
}

// Returns true if the Zod shape for a key is wrapped in .optional() at top level.
function isOptional(def: ZodDefNode): boolean {
  if (!def) return false;
  if (def.type === "optional") return true;
  // ZodPipe — check the output side (rarely optional, but handle it)
  if (def.type === "pipe" && def.in) return isOptional(def.in._def);
  return false;
}
function isZodOptional(key: string): boolean {
  const shape = envObject.shape as Record<string, { _def: ZodDefNode }>;
  const fieldSchema = shape[key];
  if (!fieldSchema) return false;
  return isOptional(fieldSchema._def);
}

// A key is "always required" when the Zod shape declares it without a default
// AND without .optional(). Emitting such a key as a commented placeholder in
// .env.example would mislead developers doing `cp .env.example .env.local` —
// they'd get a boot-time "Required" error. Emit uncommented instead (CF4).
function isAlwaysRequired(key: string): boolean {
  return !hasZodDefault(null, key) && !isZodOptional(key);
}

// Secret-pattern guard (NF-4.6 / S16).
// If a value matches the hex-32+ pattern:
//   - secret: true  → replace with placeholder comment
//   - secret: false → abort with exit 1
const HEX32_RE = /^[A-Fa-f0-9]{32,}$/;
const KEY_PLACEHOLDER = "# generate via: npm run generate:key";

function guardExample(key: string, value: string | undefined, isSecret: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (HEX32_RE.test(value)) {
    if (isSecret) {
      // Replace with canonical placeholder — never emit plausible hex in .env.example
      return KEY_PLACEHOLDER;
    } else {
      console.error(
        `ERROR: sidecar bug — key "${key}" has a hex-32+ example value but secret is not true.\n` +
          `  Fix: add 'secret: true' to the sidecar entry or change the example value.`,
      );
      process.exit(1);
    }
  }
  return value;
}

// ── Sort entries ──────────────────────────────────────────────────────────

const compareKey = makeEnvKeyCollator(locale);

type Entry = {
  key: string;
  groupIndex: number;
  order: number;
};

const entries: Entry[] = Object.keys(descriptions).map((key) => {
  const entry = descriptions[key as keyof typeof descriptions];
  return {
    key,
    groupIndex: GROUPS.indexOf(entry.group),
    order: entry.order,
  };
});

entries.sort((a, b) => {
  if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
  if (a.order !== b.order) return a.order - b.order;
  // Stable tiebreaker using collator (should not be needed in practice).
  // Using makeEnvKeyCollator from ./lib/env-sort so tests can exercise the
  // same comparator directly without re-implementation (T26/CT2).
  return compareKey(a.key, b.key);
});

// ── Generate output ───────────────────────────────────────────────────────

const lines: string[] = [];
let currentGroupIndex = -1;

for (const { key, groupIndex } of entries) {
  const sidecar = descriptions[key as keyof typeof descriptions];
  const isNewGroup = groupIndex !== currentGroupIndex;

  if (isNewGroup) {
    if (lines.length > 0) lines.push("");
    lines.push(`# --- ${GROUPS[groupIndex]} ---`);
    lines.push("");
    currentGroupIndex = groupIndex;
  }

  // Description comment lines
  const descLines = wrapDescriptionLines(sidecar.description);
  for (const dl of descLines) {
    lines.push(`# ${dl}`);
  }

  // Determine the example value after secret guard
  const guardedExample = guardExample(key, sidecar.example, sidecar.secret);

  // If the guard replaced with placeholder, format as a full-line comment
  if (guardedExample === KEY_PLACEHOLDER) {
    lines.push(`# ${key}=`);
    lines.push(KEY_PLACEHOLDER);
    lines.push("");
    continue;
  }

  // Emit uncommented when:
  //   - the key has a Zod .default() — it always has a runtime value; OR
  //   - the key is always-required (no default, no .optional()) — CF4 fix:
  //     developers doing `cp .env.example .env.local && npm run dev` must see
  //     the assignment uncommented so the template shows what to fill in.
  // Emit commented when the key is truly optional (may be left unset at boot).
  const emitUncommented =
    hasZodDefault(null as never, key) || isAlwaysRequired(key);

  if (emitUncommented) {
    lines.push(`${key}=${guardedExample ?? ""}`);
  } else {
    const val = guardedExample !== undefined ? guardedExample : "";
    lines.push(`# ${key}=${val}`);
  }

  lines.push("");
}

// ── External allowlist entries (docker-compose / build-time / scripts) ───
// Emit allowlist entries marked `includeInExample: true` in a dedicated
// trailing section so operators see vars that are REQUIRED for their
// deployment path (docker-compose, production build, provisioning scripts)
// even though our Next.js app does not read them.
const externalEntries = ALLOWLIST.filter(
  (e): e is Extract<typeof ALLOWLIST[number], { type: "literal" }> =>
    e.type === "literal" && e.includeInExample === true,
);

if (externalEntries.length > 0) {
  lines.push("");
  lines.push("# ===========================================================");
  lines.push("# External / Build-time (not read by the Next.js app)");
  lines.push("# ===========================================================");
  lines.push("#");
  lines.push("# The following vars are NOT in the Zod schema and are not");
  lines.push("# validated at app startup. They are required by external");
  lines.push("# consumers: docker-compose.yml, the Sentry webpack plugin,");
  lines.push("# or one-shot provisioning scripts. docker-compose reads");
  lines.push("# .env by default; to share this file with docker pass");
  lines.push("# `--env-file .env.local` (see README 'Configure environment').");
  lines.push("");

  for (const entry of externalEntries) {
    const desc = entry.description ?? entry.justification.split("\n")[0];
    for (const dl of wrapDescriptionLines(desc)) {
      lines.push(`# ${dl}`);
    }

    // Secret-pattern guard also applies here (NF-4.6): hex-32+ example
    // on a non-secret field aborts; hex-32+ on a secret field is replaced
    // with a placeholder.
    const guarded = guardExample(entry.key, entry.example, entry.secret);
    if (guarded === KEY_PLACEHOLDER) {
      // Secret fields with a placeholder always emit commented + placeholder.
      lines.push(`# ${entry.key}=`);
      lines.push(KEY_PLACEHOLDER);
    } else if (entry.requiredForConsumer) {
      // CF7: operator MUST configure this var for the standard deployment
      // path. Emit uncommented (parallel to CF4 always-required Zod fields)
      // so `cp .env.example .env.local` produces a usable template.
      const val = guarded ?? "";
      lines.push(`${entry.key}=${val}`);
    } else {
      const val = guarded ?? "";
      lines.push(`# ${entry.key}=${val}`);
    }
    lines.push("");
  }
}

// Output ends with a single trailing newline
const output = lines.join("\n").trimEnd() + "\n";

// ── Write ──────────────────────────────────────────────────────────────────

const outPath = outPathOverride
  ? path.resolve(outPathOverride)
  : path.join(process.cwd(), ".env.example");
fs.writeFileSync(outPath, output, "utf8");
console.log(`Wrote ${outPath} (${entries.length} entries)`);
