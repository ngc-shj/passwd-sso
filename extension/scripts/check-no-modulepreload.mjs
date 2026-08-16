#!/usr/bin/env node
/**
 * Fails the build when any emitted HTML carries a <link rel="modulepreload">.
 *
 * Under chrome-extension://, Vite's `crossorigin` preload links are fetched in a
 * different request world than the module graph, so Chrome never matches them —
 * every shared chunk is fetched twice and the console fills with cross-world
 * mismatch warnings. `modulePreload: false` in vite.config.ts removes them; this
 * gate is what stops a Vite upgrade or a config merge from quietly restoring it.
 *
 * The absent-subject cases matter as much as the positive one: a missing dist/,
 * a walk that finds no HTML, or a throw inside the walk must all exit non-zero.
 * "Scanned nothing" must never be reported the same way as "found nothing".
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const FORBIDDEN = 'rel="modulepreload"';

process.on("unhandledRejection", (err) => {
  console.error(`check-no-modulepreload: unhandled rejection: ${err}`);
  process.exit(1);
});

async function collectHtml(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectHtml(full)));
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found;
}

try {
  const htmlFiles = await collectHtml(DIST);

  // An empty scan is a broken gate, not a clean build.
  if (htmlFiles.length === 0) {
    console.error("check-no-modulepreload: scanned 0 HTML files under dist/ — the build output is missing or the walk is broken");
    process.exit(1);
  }

  const offenders = [];
  for (const file of htmlFiles) {
    if ((await readFile(file, "utf8")).includes(FORBIDDEN)) offenders.push(file);
  }

  if (offenders.length > 0) {
    console.error(`check-no-modulepreload: ${FORBIDDEN} found in ${offenders.length} file(s):`);
    for (const file of offenders) console.error(`  ${file}`);
    console.error("Set `build.modulePreload: false` in vite.config.ts.");
    process.exit(1);
  }

  // The count is the evidence that the gate actually examined something.
  console.log(`check-no-modulepreload: ${htmlFiles.length} HTML file(s) scanned, no modulepreload links`);
} catch (err) {
  console.error(`check-no-modulepreload: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
