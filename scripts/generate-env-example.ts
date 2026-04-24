/**
 * Generates .env.example from the Zod schema + sidecar descriptions.
 *
 * Key ordering: sorted by (GROUPS.indexOf(group), order) tuple — never by
 * envObject.shape iteration order (NF-3 determinism requirement).
 *
 * Run: tsx scripts/generate-env-example.ts [--locale=<tag>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { envObject } from "@/lib/env-schema";
import { GROUPS, descriptions } from "./env-descriptions";

// ── Arg parsing ───────────────────────────────────────────────────────────

const localeArg = process.argv.find((a) => a.startsWith("--locale="));
const locale = localeArg ? localeArg.split("=")[1] : "en";

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

const collator = new Intl.Collator(locale, { sensitivity: "variant" });

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
  // Stable tiebreaker using collator (should not be needed in practice)
  return collator.compare(a.key, b.key);
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

  // Determine if this key has a Zod default
  const isRequired = hasZodDefault(null as never, key);

  // Keys with a .default() → emit as uncommented (they always have a value)
  // Keys without → emit as commented (optional or conditionally required)
  if (isRequired) {
    lines.push(`${key}=${guardedExample ?? ""}`);
  } else {
    const val = guardedExample !== undefined ? guardedExample : "";
    lines.push(`# ${key}=${val}`);
  }

  lines.push("");
}

// Output ends with a single trailing newline
const output = lines.join("\n").trimEnd() + "\n";

// ── Write ──────────────────────────────────────────────────────────────────

const outPath = path.join(process.cwd(), ".env.example");
fs.writeFileSync(outPath, output, "utf8");
console.log(`Wrote ${outPath} (${entries.length} entries)`);
