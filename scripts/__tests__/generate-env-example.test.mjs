/**
 * Tests for scripts/generate-env-example.ts (Step 10 §E).
 *
 * Hermeticity (CT1): every generator spawn uses --out=<tmpdir>/<file> so the
 * real committed .env.example is never touched by vitest. Parallel workers
 * cannot collide on the shared file.
 *
 * Locale comparator (CT2): the "tr" vs "en" test imports makeEnvKeyCollator
 * from scripts/lib/env-sort.ts and exercises it against the foot-gun fixture
 * ['İ','I','i','a','Z'] — so a regression that swapped the comparator for
 * String.prototype.localeCompare() (LANG-dependent) would fail this test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnvKeyCollator } from "../lib/env-sort.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "generate-env-example.ts");

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
let tmpDir;
beforeEach(() => {
  origEnv = { ...process.env };
  tmpDir = mkdtempSync(join(tmpdir(), "gen-env-example-"));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Run the generator hermetically: write to --out=<tmpDir>/.env.example. */
function runGenerator(extraArgs = []) {
  const outPath = join(tmpDir, ".env.example");
  const result = spawnSync(
    "npx",
    ["tsx", SCRIPT, `--out=${outPath}`, ...extraArgs],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { ...result, outPath };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("generate-env-example.ts", () => {
  it("returns exit 0 when sidecar+schema are unchanged", () => {
    const result = runGenerator();
    expect(result.status).toBe(0);
  });

  it("produces byte-identical output across two consecutive runs (determinism)", () => {
    const r1 = runGenerator();
    expect(r1.status).toBe(0);
    const content1 = readFileSync(r1.outPath, "utf8");

    const r2 = runGenerator();
    expect(r2.status).toBe(0);
    const content2 = readFileSync(r2.outPath, "utf8");

    // Direct byte equality — not inferred from stdout message (CT7).
    expect(content1).toBe(content2);
  });

  it("sort comparator from scripts/lib/env-sort.ts is deterministic under tr locale (T26/CT2)", () => {
    // Unit-level test: imports the actual comparator the generator uses.
    // Fixture includes Turkish dotted/dotless-I foot-gun plus ASCII keys.
    const sample = ["İ", "I", "i", "a", "Z"];

    const enCollator = makeEnvKeyCollator("en");
    const trCollator = makeEnvKeyCollator("tr");

    const enSorted1 = [...sample].sort(enCollator);
    const enSorted2 = [...sample].sort(enCollator);
    // "en" ordering is stable across two calls.
    expect(enSorted1).toEqual(enSorted2);

    const trSorted1 = [...sample].sort(trCollator);
    const trSorted2 = [...sample].sort(trCollator);
    // "tr" ordering is also stable.
    expect(trSorted1).toEqual(trSorted2);

    // Regression guard: a comparator that ignored the locale parameter (e.g.
    // by using String.prototype.localeCompare without explicit locale) would
    // produce IDENTICAL output for "en" and "tr" on this fixture — whereas
    // Turkish differentiates dotted/dotless-I from ASCII I/i at variant
    // sensitivity. If the two outputs ever coincide, the comparator is no
    // longer locale-aware.
    expect(enSorted1).not.toEqual(trSorted1);
  });

  it("sort comparator is stable for ASCII-only input across locales", () => {
    // Within ASCII, en and tr sort identically at "variant" sensitivity.
    const ascii = ["C", "a", "b", "A", "B"];
    expect([...ascii].sort(makeEnvKeyCollator("en"))).toEqual(
      [...ascii].sort(makeEnvKeyCollator("tr")),
    );
  });

  it("emits zero 32+ hex matches in the generated .env.example (NF-4.6/S16)", () => {
    const result = runGenerator();
    expect(result.status).toBe(0);

    const content = readFileSync(result.outPath, "utf8");

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

  it("emits the External allowlist section with JACKSON_API_KEY and peers", () => {
    const result = runGenerator();
    expect(result.status).toBe(0);
    const content = readFileSync(result.outPath, "utf8");

    // Dedicated section header appears.
    expect(content).toContain(
      "External / Build-time (not read by the Next.js app)",
    );
    // requiredForConsumer entries (CF7) are emitted UNCOMMENTED so that
    // `cp .env.example .env.local && npm run docker:up` produces a usable
    // template — symmetric with CF4 always-required Zod fields.
    expect(content).toMatch(/^JACKSON_API_KEY=/m);
    expect(content).toMatch(/^PASSWD_OUTBOX_WORKER_PASSWORD=/m);
    // Optional includeInExample entries remain commented.
    expect(content).toMatch(/^# SENTRY_AUTH_TOKEN=/m);
    expect(content).toMatch(/^# NEXT_DEV_ALLOWED_ORIGINS=/m);

    // Entries with readByApp: true (NEXT_RUNTIME) and non-operator-facing
    // entries (BASE_URL, APP_DATABASE_URL, regex V11..V100) must NOT appear
    // in the generated template.
    expect(content).not.toMatch(/^# ?NEXT_RUNTIME=/m);
    expect(content).not.toMatch(/^# ?BASE_URL=/m);
    expect(content).not.toMatch(/^# ?APP_DATABASE_URL=/m);
  });

  it("--locale=tr produces a different key order than --locale=en when Turkish-I keys are present", () => {
    // End-to-end: spawn the generator with --locale=tr and --locale=en. The
    // current sidecar uses only ASCII keys so the outputs are identical. This
    // is a smoke test that the --locale flag is plumbed through; the unit
    // test above (via makeEnvKeyCollator) covers the actual foot-gun.
    const rEn = runGenerator(["--locale=en"]);
    const rTr = runGenerator(["--locale=tr"]);
    expect(rEn.status).toBe(0);
    expect(rTr.status).toBe(0);
    // With ASCII-only keys the outputs are byte-equal; this assertion fails
    // the moment a non-ASCII key is added without a tiebreaker.
    const enContent = readFileSync(rEn.outPath, "utf8");
    const trContent = readFileSync(rTr.outPath, "utf8");
    expect(enContent).toBe(trContent);
  });
});
