#!/usr/bin/env node
/**
 * Build-output gate over dist/. Two checks, one walk.
 *
 * 1. No <link rel="modulepreload"> in emitted HTML. Under chrome-extension://,
 *    Vite's `crossorigin` preload links are fetched in a different request world
 *    than the module graph, so Chrome never matches them — every shared chunk is
 *    fetched twice and the console fills with cross-world mismatch warnings.
 *    `modulePreload: false` in vite.config.ts removes them; this gate is what
 *    stops a Vite upgrade or a config merge from quietly restoring it.
 *
 * 2. No OS/editor junk files. `emptyOutDir` does NOT remove dotfiles, so a
 *    .DS_Store created by browsing dist/ in Finder survives every rebuild and
 *    lands in any archive made from the directory — which is how one reached a
 *    hand-built extension zip. There is no packaging script to fix instead, so
 *    the check belongs here, on the directory the build owns.
 *
 * The absent-subject cases matter as much as the positive ones: a missing dist/,
 * a walk that finds no HTML, or a throw inside the walk must all exit non-zero.
 * "Scanned nothing" must never be reported the same way as "found nothing".
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const FORBIDDEN_HTML = 'rel="modulepreload"';

// Matched on basename. Chrome rejects an unpacked extension containing a
// directory whose name starts with "_" (reserved), but junk files are the
// realistic case and are silently packaged instead.
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".AppleDouble"]);

process.on("unhandledRejection", (err) => {
  console.error(`check-dist-hygiene: unhandled rejection: ${err}`);
  process.exit(1);
});

async function walk(dir) {
  const html = [];
  const junk = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walk(full);
      html.push(...nested.html);
      junk.push(...nested.junk);
    } else if (JUNK_FILES.has(entry.name)) {
      junk.push(full);
    } else if (entry.name.endsWith(".html")) {
      html.push(full);
    }
  }
  return { html, junk };
}

try {
  const { html, junk } = await walk(DIST);

  // An empty scan is a broken gate, not a clean build.
  if (html.length === 0) {
    console.error(
      "check-dist-hygiene: scanned 0 HTML files under dist/ — the build output is missing or the walk is broken",
    );
    process.exit(1);
  }

  const failures = [];

  if (junk.length > 0) {
    failures.push(
      `${junk.length} junk file(s) in dist/ — they would be packaged into the extension archive:\n` +
        junk.map((f) => `  ${relative(DIST, f)}`).join("\n") +
        "\n  Remove them (emptyOutDir does not clear dotfiles) before packaging.",
    );
  }

  const offenders = [];
  for (const file of html) {
    if ((await readFile(file, "utf8")).includes(FORBIDDEN_HTML)) offenders.push(file);
  }
  if (offenders.length > 0) {
    failures.push(
      `${FORBIDDEN_HTML} found in ${offenders.length} file(s):\n` +
        offenders.map((f) => `  ${relative(DIST, f)}`).join("\n") +
        "\n  Set `build.modulePreload: false` in vite.config.ts.",
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`check-dist-hygiene: ${failure}`);
    process.exit(1);
  }

  // The counts are the evidence that the gate actually examined something.
  console.log(
    `check-dist-hygiene: ${html.length} HTML file(s) scanned, no modulepreload links, no junk files`,
  );
} catch (err) {
  console.error(
    `check-dist-hygiene: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
