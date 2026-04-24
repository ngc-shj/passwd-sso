/**
 * Tests for the Node gitleaks fallback (SEC-5/S14/S20) via
 * scripts/lib/hex-leak-scan.mjs.
 *
 * Five synthetic diff fixtures as TEXT constants — no subprocess spawning.
 * Imports the named export scanDiff(diffText, filePath) directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanDiff } from "../lib/hex-leak-scan.mjs";

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
beforeEach(() => { origEnv = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// ── fixture hex strings ───────────────────────────────────────────────────────

// A valid 64-char hex string that looks like a secret.
const FAKE_HEX64 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// ── diff fixture helpers ──────────────────────────────────────────────────────

function makeDiff(addedLines, filePath = "foo.env") {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,0 +1,${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("hex-leak-scan.mjs scanDiff()", () => {
  it("(a) detects hex in a dotenv assignment line and returns at least one match", () => {
    // +SHARE_MASTER_KEY=<64hex> in foo.env
    const diff = makeDiff([`SHARE_MASTER_KEY=${FAKE_HEX64}`], "foo.env");
    const matches = scanDiff(diff, "foo.env");
    expect(matches.length).toBeGreaterThan(0);
    // Snippet should be the first 8 chars of the hex.
    expect(matches[0].hexPrefix).toBe(FAKE_HEX64.slice(0, 8));
  });

  it("(b) detects hex in a TypeScript string literal and returns at least one match", () => {
    // +const K = "<64hex>"; in foo.ts
    const diff = makeDiff([`const K = "${FAKE_HEX64}";`], "foo.ts");
    const matches = scanDiff(diff, "foo.ts");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("(c) exempts hex inside a dotenv comment line and returns NO match", () => {
    // +# example: <64hex>
    const diff = makeDiff([`# example: ${FAKE_HEX64}`], "foo.env");
    const matches = scanDiff(diff, "foo.env");
    expect(matches).toHaveLength(0);
  });

  it("(d) exempts hex inside a /* ... */ block comment in TypeScript and returns NO match", () => {
    // Block comment spanning multiple diff lines in foo.ts
    const diff = makeDiff(
      [
        "/*",
        ` * ${FAKE_HEX64}`,
        " */",
      ],
      "foo.ts",
    );
    const matches = scanDiff(diff, "foo.ts");
    expect(matches).toHaveLength(0);
  });

  it("(d-bare) exempts hex on a BARE line inside a /* ... */ block — state machine must track cross-line context (CT4)", () => {
    // The hex line has NO leading ` * ` / `#` / `//` — only the block-state
    // machine can exempt it. If the scanner relies purely on the single-line
    // comment regex, this test fails.
    const diff = makeDiff(
      [
        "/*",
        `${FAKE_HEX64}`,
        "*/",
      ],
      "foo.ts",
    );
    const matches = scanDiff(diff, "foo.ts");
    expect(matches).toHaveLength(0);
  });

  it("(f) exempts hex inside a SAME-LINE /* ... */ block comment (CS1)", () => {
    // `+const x = /* <64hex> */;` — both opener and closer on one line.
    // Without the inline-strip fix, HEX64_RE would still flag the line.
    const diff = makeDiff(
      [`const x = /* ${FAKE_HEX64} */;`],
      "foo.ts",
    );
    const matches = scanDiff(diff, "foo.ts");
    expect(matches).toHaveLength(0);
  });

  it("(g) still flags a SAME-LINE block comment when hex leaks OUTSIDE the comment", () => {
    // Defense against over-eager stripping: hex BEFORE the /* ... */ is still a leak.
    const diff = makeDiff(
      [`const leaked = "${FAKE_HEX64}"; /* benign */`],
      "foo.ts",
    );
    const matches = scanDiff(diff, "foo.ts");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("(e) conservatively matches hex in a Markdown fenced code block (fail-closed per S20)", () => {
    // Markdown fenced code blocks are NOT exempt — fail-closed.
    // In a .md file, indented hex inside a fenced section is still flagged.
    const diff = makeDiff(
      [
        "```",
        `    ${FAKE_HEX64}`,
        "```",
      ],
      "foo.md",
    );
    const matches = scanDiff(diff, "foo.md");
    // The hex line is NOT a comment, so it MUST be flagged.
    expect(matches.length).toBeGreaterThan(0);
  });
});
