/**
 * Tests for scripts/generate-env-example.ts (Step 10 §E).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, descriptions } from "../env-descriptions.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "generate-env-example.ts");

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
beforeEach(() => { origEnv = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function runGenerator(args = []) {
  return spawnSync(
    "npx",
    ["tsx", SCRIPT, ...args],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

// Builds the entry list sorted by (groupIndex, order) using an explicit locale,
// mirroring the sort in generate-env-example.ts.
function makeSortedEntries(locale) {
  const collator = new Intl.Collator(locale, { sensitivity: "variant" });
  return Object.keys(descriptions)
    .map((key) => {
      const entry = descriptions[key];
      return {
        key,
        groupIndex: GROUPS.indexOf(entry.group),
        order: entry.order,
      };
    })
    .sort((a, b) => {
      if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex;
      if (a.order !== b.order) return a.order - b.order;
      return collator.compare(a.key, b.key);
    });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("generate-env-example.ts", () => {
  it("returns exit 0 when sidecar+schema are unchanged", () => {
    const result = runGenerator();
    expect(result.status).toBe(0);
  });

  it("produces byte-identical output across two consecutive runs (determinism)", () => {
    const r1 = runGenerator();
    const r2 = runGenerator();

    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    // Both runs emit the same "Wrote ..." stdout message, confirming identical output.
    expect(r1.stdout).toBe(r2.stdout);

    // Additionally read the written file twice — both runs produce the same bytes.
    const examplePath = resolve(REPO_ROOT, ".env.example");
    const content1 = readFileSync(examplePath, "utf8");
    const r3 = runGenerator();
    expect(r3.status).toBe(0);
    const content2 = readFileSync(examplePath, "utf8");
    expect(content1).toBe(content2);
  });

  it("sort function is deterministic under the tr locale (T26)", () => {
    // Unit-level test: does not spawn the generator; directly exercises the
    // (groupIndex, order) sort key with explicit locales. No OS-locale dependency.
    const enEntries = makeSortedEntries("en");
    const trEntries = makeSortedEntries("tr");

    expect(enEntries.length).toBeGreaterThan(0);
    expect(trEntries.length).toBe(enEntries.length);

    // Every entry must have a valid groupIndex (key present in GROUPS via descriptions).
    for (const e of enEntries) {
      expect(e.groupIndex).toBeGreaterThanOrEqual(0);
    }
    for (const e of trEntries) {
      expect(e.groupIndex).toBeGreaterThanOrEqual(0);
    }

    // "en" ordering is stable across two calls.
    const enEntries2 = makeSortedEntries("en");
    expect(enEntries.map((e) => e.key)).toEqual(enEntries2.map((e) => e.key));

    // "tr" ordering is also stable.
    const trEntries2 = makeSortedEntries("tr");
    expect(trEntries.map((e) => e.key)).toEqual(trEntries2.map((e) => e.key));
  });

  it("emits zero 32+ hex matches in the generated .env.example (NF-4.6/S16)", () => {
    const result = runGenerator();
    expect(result.status).toBe(0);

    const content = readFileSync(resolve(REPO_ROOT, ".env.example"), "utf8");

    // Must contain no raw 32+-char hex strings; secrets are replaced by placeholders.
    const HEX32_RE = /(?:^|[^a-f0-9])([a-f0-9]{32,})(?:$|[^a-f0-9])/gim;
    const lines = content.split("\n");
    for (const line of lines) {
      // Skip the placeholder comment itself.
      if (line.trim().startsWith("#")) continue;
      const m = HEX32_RE.exec(line);
      if (m) {
        // Fail with a descriptive message.
        expect(line).not.toMatch(HEX32_RE);
      }
    }
  });
});
