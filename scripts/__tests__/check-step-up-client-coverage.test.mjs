/**
 * Self-test for scripts/checks/check-step-up-client-coverage.sh — the CI guard
 * that requires every step-up-gated server route to have a client caller which
 * handles the SESSION_STEP_UP_REQUIRED 403.
 *
 * The guard is the completeness backstop for an enumeration class (plan F7:
 * per-component enumeration under-counts because a component can handle POST but
 * not its DELETE). A regression in its detection would silently reopen that
 * class, so it gets its own test asserting it catches each failure mode.
 *
 * Driven against fixtures via STEPUP_CLIENT_GUARD_* env overrides so the test
 * never mutates tracked files.
 *
 * Fixtures (plan C1 self-test i–vii):
 *   (i)   server id + client marker + branch in window            → PASS
 *   (ii)  server id, NO client marker (付け漏れ)                   → FAIL (coverage S\C)
 *   (iii) client marker, NO branch within adjacency window        → FAIL (handling)
 *   (iv)  exempt entry whose named custom marker is absent         → FAIL (anti-drift)
 *   (v)   requireRecentCurrentAuthMethod call with NO marker       → FAIL (server completeness)
 *   (vi)  client id with no server match (renamed/stale)           → FAIL (anti-orphan)
 *   (vii) ONE file, TWO marked handlers, only A branches           → FAIL pointing at B
 *         (the ONLY fixture that passes under file-scoping and fails under
 *          adjacency-scoping — the direct regression lock for the live
 *          mcp-client-card POST-handled / DELETE-unhandled gap).
 *   (viii) throwIfStepUp with no isStepUpRequiredError consumer      → FAIL (thrower↔catcher)
 *   (ix)  requireRecentSession (a DIFFERENT gate primitive) is       → FAIL (server completeness)
 *         discovered — the guard's class is "returns SESSION_STEP_UP_REQUIRED",
 *         not "calls requireRecentCurrentAuthMethod".
 *   (x)   `@browser-redirect` sentinel exempts a browser-only route  → PASS
 *         with no fetch UI caller (recovery is the server's redirect).
 *
 * C2/C3 additions (plan security-review-followups #C2/#C3):
 *   (xi)  @browser-redirect exemption whose route file has no                → FAIL
 *         '@browser-redirect-recovery' marker
 *         (BROWSER_REDIRECT_RECOVERY_MISSING)
 *   (xii) @browser-redirect-recovery marker present but no redirect( call    → FAIL
 *         within +/-3 lines (BROWSER_REDIRECT_RECOVERY_MISSING, unanchored)
 *   (xii-decoy) marker anchored only by a // decoy comment mentioning         → FAIL
 *         "redirect" with no real call (the S2 bypass)
 *   (xii-block-decoy) marker anchored only by a C-style block-comment decoy   → FAIL
 *         mentioning redirect( with no real call (the S4 bypass)
 *   (xii-redirectToSignIn) marker anchored by a redirectToSignIn() call      → PASS
 *   (xiii) @browser-redirect exemption whose sibling route.test.ts has no    → FAIL
 *         '@browser-redirect-recovery-test' marker (BROWSER_REDIRECT_TEST_MISSING)
 *   (xiv) manifest missing a server id                                       → FAIL
 *         (MANIFEST_ID_MISSING)
 *   (xv)  manifest has a stale key with no matching server id                → FAIL
 *         (MANIFEST_ID_STALE)
 *   (xvi) fetchApi( call site matches a covered id's path token + method     → FAIL
 *         with no client @stepup marker in that file
 *         (UNMARKED_CALLSITE_CANDIDATE)
 *   (xvii) same as (xvi) but suppressed via `@stepup-path-ok id:X <reason>`  → PASS
 *   (xviii) manifest + detector happy path: id covered, manifest entry       → PASS
 *         present, matching call site correctly marked
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-step-up-client-coverage.sh");

const STEPUP_CALL =
  "  const stepUp = await requireRecentCurrentAuthMethod(req); if (stepUp) return stepUp;";
// A second gate primitive that also emits SESSION_STEP_UP_REQUIRED — the guard
// must discover it the same as requireRecentCurrentAuthMethod (anti-drift: the
// class is "returns the 403 code", not "calls one named function").
const STEPUP_CALL_SESSION =
  "  const stepUp = await requireRecentSession(req); if (stepUp) return stepUp;";
// A third primitive: the freshness core itself, called directly rather than
// through one of the wrapper gates above.
const STEPUP_CALL_FRESHNESS =
  "  const freshness = await evaluateStepUpFreshness(token); if (freshness !== \"fresh\") return stepUpResponse();";

let root;
let apiDir;
let clientDir;
let exemptFile;
let pathsFile;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      STEPUP_CLIENT_GUARD_API_DIR: apiDir,
      STEPUP_CLIENT_GUARD_CLIENT_DIR: clientDir,
      STEPUP_CLIENT_GUARD_PATH_ROOT: root,
      STEPUP_CLIENT_GUARD_EXEMPT_FILE: exemptFile,
      STEPUP_CLIENT_GUARD_PATHS_FILE: pathsFile,
      // The guard refuses STEPUP_CLIENT_GUARD_* overrides under CI unless the
      // caller acknowledges it is a fixture run (ENV_POLLUTION_GUARD). This
      // suite is exactly that caller.
      STEPUP_CLIENT_GUARD_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Write a server route fixture at api/<rel>/route.ts. */
function writeRoute(rel, body) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
}

/** Write a client component fixture under src/<rel>. */
function writeClient(rel, body) {
  const full = join(clientDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/**
 * Write scripts/checks/stepup-route-paths.json fixture content (check 5/6).
 * `entries` maps id -> { method, pathTokens }. Kept one-id-per-line, matching
 * the production manifest's format constraint the guard's grep/awk relies on.
 */
function writePathsManifest(entries) {
  const lines = ["{"];
  for (const [id, { method, pathTokens }] of Object.entries(entries)) {
    const tokens = pathTokens.map((t) => JSON.stringify(t)).join(", ");
    lines.push(`  "${id}": { "method": "${method}", "pathTokens": [${tokens}] },`);
  }
  lines.push("}");
  writeFileSync(pathsFile, lines.join("\n") + "\n", "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stepup-client-guard-"));
  apiDir = join(root, "src", "app", "api");
  clientDir = join(root, "src");
  exemptFile = join(root, "exempt.txt");
  pathsFile = join(root, "stepup-route-paths.json");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
  // Default: empty-but-valid manifest. Tests that create server ids either use
  // writePathsManifest() to bind them (keeping check 5 green), or accept the
  // resulting MANIFEST_ID_MISSING as part of what they assert (none of the
  // pre-C3 fixtures do — see the per-test manifest calls below).
  writeFileSync(pathsFile, "{\n}\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-step-up-client-coverage.sh", () => {
  it("(i) PASSES: server marker + client marker + branch in window", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "async function handleSave() {",
        "  // @stepup id:widget-put",
        '  const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "  if (!res.ok) {",
        "    if (await handleStepUpError(res, trigger)) return;",
        "  }",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(ii) FAILS (MISSING_CLIENT_MARKER): server marker, no client marker", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    // No client marker anywhere.
    writeClient(
      "components/widget-card.tsx",
      'const res = await fetchApi("/api/widgets/x", { method: "PUT" });\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_CLIENT_MARKER");
    expect(stdout).toContain("widget-put");
  });

  it("(iii) FAILS (CLIENT_BRANCH_MISSING): marker present, no branch in window", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (!res.ok) {",
        '  toast.error("generic");', // no step-up branch
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("CLIENT_BRANCH_MISSING");
  });

  it("(iv) FAILS (EXEMPT_MARKER_ABSENT): exempt entry's custom marker missing", () => {
    writePathsManifest({
      "ext-post": { method: "POST", pathTokens: ["/api/extension/bridge-code"] },
    });
    writeRoute(
      "extension/bridge-code",
      `// @stepup id:ext-post method:POST\n${STEPUP_CALL}\n`,
    );
    // Exempt it, naming a custom marker that does NOT exist in the client tree.
    writeFileSync(
      exemptFile,
      "ext-post  CUSTOM_MARKER_THAT_DOES_NOT_EXIST  # auto-extension custom recovery\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("EXEMPT_MARKER_ABSENT");
  });

  it("(iv-pass) PASSES: exempt entry whose custom marker IS present", () => {
    writePathsManifest({
      "ext-post": { method: "POST", pathTokens: ["/api/extension/bridge-code"] },
    });
    writeRoute(
      "extension/bridge-code",
      `// @stepup id:ext-post method:POST\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/auto-extension.tsx",
      "if (x === CUSTOM_MARKER) doThing();\n",
    );
    writeFileSync(
      exemptFile,
      "ext-post  CUSTOM_MARKER  # auto-extension custom recovery channel\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(v) FAILS (SERVER_MARKER_MISSING): gated call with no server marker", () => {
    writeRoute("widgets/[id]", `${STEPUP_CALL}\n`); // no marker line
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SERVER_MARKER_MISSING");
  });

  it("(vi) FAILS (ORPHAN_CLIENT_MARKER): client id with no server match", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
        "// @stepup id:renamed-stale-id",
        'const res2 = await fetchApi("/api/widgets/y", { method: "DELETE" });',
        "if (await handleStepUpError(res2, trigger)) return;",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ORPHAN_CLIENT_MARKER");
    expect(stdout).toContain("renamed-stale-id");
  });

  it("(vii) FAILS at handler B: one file, two marked handlers, only A branches", () => {
    writePathsManifest({
      "mcp-put": { method: "PUT", pathTokens: ["/api/mcp-clients"] },
      "mcp-delete": { method: "DELETE", pathTokens: ["/api/mcp-clients"] },
    });
    // Two distinct gated server ids, both with markers.
    writeRoute(
      "mcp-clients/[id]",
      [
        "// @stepup id:mcp-put method:PUT",
        STEPUP_CALL,
        "// filler ".repeat(1),
        "// @stepup id:mcp-delete method:DELETE",
        STEPUP_CALL,
      ].join("\n") + "\n",
    );
    // Client: handler A (mcp-put) branches; handler B (mcp-delete) does NOT.
    // A whole-FILE grep sees SESSION_STEP_UP_REQUIRED once and would PASS both;
    // adjacency scoping fails B because its marker has no branch in-window.
    const filler = Array.from({ length: 45 }, (_, i) => `  // pad ${i}`).join(
      "\n",
    );
    writeClient(
      "components/mcp-client-card.tsx",
      [
        "async function handleEdit() {",
        "  // @stepup id:mcp-put",
        '  const res = await fetchApi("/api/mcp-clients/x", { method: "PUT" });',
        "  if (!res.ok) {",
        "    if (await handleStepUpError(res, trigger)) return;",
        "  }",
        "}",
        filler, // push handler B's marker far from A's branch
        "async function handleDelete() {",
        "  // @stepup id:mcp-delete",
        '  const res = await fetchApi("/api/mcp-clients/x", { method: "DELETE" });',
        "  if (!res.ok) {",
        '    toast.error("generic"); // NO step-up branch — the live gap',
        "  }",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("CLIENT_BRANCH_MISSING");
    expect(stdout).toContain("mcp-delete");
    // And crucially NOT a false MISSING_CLIENT_MARKER for mcp-delete (the marker
    // IS present — the defect is the missing branch, caught by adjacency).
    expect(stdout).not.toContain("MISSING_CLIENT_MARKER");
  });

  it("(viii) FAILS (THROWER_WITHOUT_CATCHER): throwIfStepUp with no isStepUpRequiredError consumer", () => {
    writePathsManifest({
      "pw-delete": { method: "DELETE", pathTokens: ["/api/passwords"] },
    });
    writeRoute(
      "passwords/[id]",
      `// @stepup id:pw-delete method:DELETE\n${STEPUP_CALL}\n`,
    );
    // Adapter throws the typed error (counts as a branch for the marker)...
    writeClient(
      "lib/vault/adapter.ts",
      [
        "// @stepup id:pw-delete",
        'const res = await fetchApi("/api/passwords/x?permanent=true", { method: "DELETE" });',
        "await throwIfStepUp(res);",
        'if (!res.ok) throw new Error("deletePermanently failed");',
      ].join("\n") + "\n",
    );
    // ...but NO consumer anywhere catches it with isStepUpRequiredError.
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STEPUP_THROWER_WITHOUT_CATCHER");
  });

  it("(viii-pass) PASSES: throwIfStepUp WITH an isStepUpRequiredError consumer", () => {
    writePathsManifest({
      "pw-delete": { method: "DELETE", pathTokens: ["/api/passwords"] },
    });
    writeRoute(
      "passwords/[id]",
      `// @stepup id:pw-delete method:DELETE\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "lib/vault/adapter.ts",
      [
        "// @stepup id:pw-delete",
        'const res = await fetchApi("/api/passwords/x?permanent=true", { method: "DELETE" });',
        "await throwIfStepUp(res);",
        'if (!res.ok) throw new Error("deletePermanently failed");',
      ].join("\n") + "\n",
    );
    writeClient(
      "components/entry-list.tsx",
      [
        "try { await adapter.deletePermanently(entry); }",
        "catch (e) { if (isStepUpRequiredError(e)) { reload(); await trigger(); return; } reload(); }",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(ix) discovers requireRecentSession as a gate primitive (SERVER_MARKER_MISSING without a marker)", () => {
    // A route gated by requireRecentSession — a DIFFERENT primitive that also
    // returns SESSION_STEP_UP_REQUIRED — must be seen by the guard. Without a
    // marker it fails server completeness, proving the primitive is in the set.
    writeRoute("mcp/authorize", `${STEPUP_CALL_SESSION}\n`); // no marker line
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SERVER_MARKER_MISSING");
  });

  it("(ix-freshness) discovers evaluateStepUpFreshness as a gate primitive (SERVER_MARKER_MISSING without a marker)", () => {
    // A route gated by evaluateStepUpFreshness — the freshness core, called
    // directly rather than through a wrapper gate — must be seen by the guard.
    // Without a marker it fails server completeness, proving the primitive is
    // in the set.
    writeRoute("mcp/authorize", `${STEPUP_CALL_FRESHNESS}\n`); // no marker line
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SERVER_MARKER_MISSING");
  });

  it("(ix-coverage) requireRecentSession route with a marker but no client caller FAILS (MISSING_CLIENT_MARKER)", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      `// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\n`,
    );
    // No client marker and not exempt → coverage gap surfaces on the new primitive.
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_CLIENT_MARKER");
    expect(stdout).toContain("mcp-authorize-get");
  });

  it("(x) PASSES: @browser-redirect sentinel exempts a browser-only route with no client token", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      // C2 hardening: a @browser-redirect exemption also requires the route's
      // own recovery marker (anchored near a `redirect` token) and a sibling
      // route.test.ts carrying the regression-test marker.
      `// @browser-redirect-recovery\n// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\nreturn redirectToSignIn();\n`,
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    // Exempt via the sentinel — deliberately NO client-tree token exists.
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(x-guard) @browser-redirect sentinel skips the client-tree anti-drift check (no EXEMPT_MARKER_ABSENT)", () => {
    // The sentinel names no client token; the anti-drift grep must NOT fire for it
    // (whereas a normal named marker that is absent would → fixture iv).
    writePathsManifest({
      "mobile-authorize-get": { method: "GET", pathTokens: ["/api/mobile/authorize"] },
    });
    writeRoute(
      "mobile/authorize",
      `// @browser-redirect-recovery\n// @stepup id:mobile-authorize-get method:GET\n${STEPUP_CALL_SESSION}\nreturn redirectToSignIn();\n`,
    );
    writeFileSync(
      join(apiDir, "mobile/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mobile-authorize-get  @browser-redirect  # mobile OAuth authorize GET, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).not.toContain("EXEMPT_MARKER_ABSENT");
  });

  it("(xi) FAILS (BROWSER_REDIRECT_RECOVERY_MISSING): @browser-redirect exemption whose route has no recovery marker", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      // No @browser-redirect-recovery marker anywhere in this route file.
      `// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\nreturn redirectToSignIn();\n`,
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_RECOVERY_MISSING");
  });

  it("(xii) FAILS (BROWSER_REDIRECT_RECOVERY_MISSING): recovery marker present but unanchored (no redirect() call within +/-3 lines)", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    // The marker sits at the top of the file, far from the actual conversion —
    // no redirect( call within +/-3 lines of it.
    const padding = Array.from({ length: 8 }, (_, i) => `// pad ${i}`).join("\n");
    writeRoute(
      "mcp/authorize",
      [
        "// @browser-redirect-recovery",
        padding,
        "// @stepup id:mcp-authorize-get method:GET",
        STEPUP_CALL_SESSION,
        "return signInBounce();", // deliberately no redirect( call anywhere nearby
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('bounces to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_RECOVERY_MISSING");
  });

  it("(xii-decoy) FAILS (BROWSER_REDIRECT_RECOVERY_MISSING): marker anchored only by a decoy comment mentioning 'redirect', no real call", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    // A comment adjacent to the marker mentions the word "redirect" but the
    // actual return dead-ends on a JSON 403 — the exact bypass S2 closes: a
    // word-only proximity check would false-PASS this.
    writeRoute(
      "mcp/authorize",
      [
        "// @stepup id:mcp-authorize-get method:GET",
        STEPUP_CALL_SESSION,
        "// @browser-redirect-recovery",
        "// we would normally redirect the browser here, but:",
        'return jsonError({ error: "generic" }, 403);',
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_RECOVERY_MISSING");
  });

  it("(xii-block-decoy) FAILS (BROWSER_REDIRECT_RECOVERY_MISSING): decoy inside a single-line /* */ block comment, no real call", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    // A /* ... */ block comment (the shape the file's JSDoc headers use)
    // mentioning redirect( must NOT satisfy the anchor — S4 regression.
    writeRoute(
      "mcp/authorize",
      [
        "// @stepup id:mcp-authorize-get method:GET",
        STEPUP_CALL_SESSION,
        "// @browser-redirect-recovery",
        "/* we would normally redirect(browser) here, but: */",
        'return jsonError({ error: "generic" }, 403);',
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_RECOVERY_MISSING");
  });

  it("(xii-substring-decoy) FAILS (BROWSER_REDIRECT_RECOVERY_MISSING): a foreign identifier ending in 'redirect(' does not spoof a real call", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    // `myredirect(` shares the suffix `redirect(` but is a different function;
    // the left word-boundary must reject it (belt-and-suspenders after S4).
    writeRoute(
      "mcp/authorize",
      [
        "// @stepup id:mcp-authorize-get method:GET",
        STEPUP_CALL_SESSION,
        "// @browser-redirect-recovery",
        "return myredirect(req);",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_RECOVERY_MISSING");
  });

  it("(xii-redirectToSignIn) PASSES: marker anchored by a redirectToSignIn() call within +/-3 lines", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      [
        "// @stepup id:mcp-authorize-get method:GET",
        STEPUP_CALL_SESSION,
        "// @browser-redirect-recovery",
        "return redirectToSignIn(req);",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "// @browser-redirect-recovery-test\nit('redirects to sign-in', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("(xiii) FAILS (BROWSER_REDIRECT_TEST_MISSING): sibling route.test.ts missing the regression-test marker", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      `// @browser-redirect-recovery\n// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\nreturn redirectToSignIn();\n`,
    );
    // Sibling test file exists but has no @browser-redirect-recovery-test marker.
    writeFileSync(
      join(apiDir, "mcp/authorize", "route.test.ts"),
      "it('does something unrelated', () => {});\n",
      "utf8",
    );
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_TEST_MISSING");
  });

  it("(xiii-no-test-file) FAILS (BROWSER_REDIRECT_TEST_MISSING): sibling route.test.ts does not exist at all", () => {
    writePathsManifest({
      "mcp-authorize-get": { method: "GET", pathTokens: ["/api/mcp/authorize"] },
    });
    writeRoute(
      "mcp/authorize",
      `// @browser-redirect-recovery\n// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\nreturn redirectToSignIn();\n`,
    );
    // No route.test.ts written at all.
    writeFileSync(
      exemptFile,
      "mcp-authorize-get  @browser-redirect  # OAuth authorize GET reached by browser navigation, redirects to sign-in\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("BROWSER_REDIRECT_TEST_MISSING");
  });

  it("(xiv) FAILS (MANIFEST_ID_MISSING): server id has no manifest entry", () => {
    // pathsFile left at the default empty manifest ({}) from beforeEach.
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MANIFEST_ID_MISSING");
    expect(stdout).toContain("widget-put");
  });

  it("(xiv-empty-tokens) FAILS (MANIFEST_ID_MISSING): manifest entry has an empty pathTokens array", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: [] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MANIFEST_ID_MISSING");
    expect(stdout).toContain("widget-put");
  });

  it("(xv) FAILS (MANIFEST_ID_STALE): manifest has a key with no matching server id", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
      "renamed-stale-manifest-id": { method: "POST", pathTokens: ["/api/stale"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MANIFEST_ID_STALE");
    expect(stdout).toContain("renamed-stale-manifest-id");
  });

  it("(xvi) FAILS (UNMARKED_CALLSITE_CANDIDATE): a SECOND, unmarked fetchApi call site for an already-covered id", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    // Properly marked call site (satisfies checks 1-3).
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    // A SECOND, totally different file also calls the same gated path+method,
    // but carries no @stepup marker at all — the new-call-site tripwire.
    writeClient(
      "hooks/use-widget-quick-edit.ts",
      [
        "async function quickEdit(id) {",
        '  const res = await fetchApi(`/api/widgets/${id}`, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
    expect(stdout).toContain("use-widget-quick-edit.ts");
    expect(stdout).toContain("widget-put");
  });

  it("(xvii) PASSES: UNMARKED_CALLSITE_CANDIDATE suppressed via @stepup-path-ok with a reason", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "hooks/use-widget-quick-edit.ts",
      [
        "async function quickEdit(id) {",
        "  // @stepup-path-ok id:widget-put confirmed false positive: quick-edit is read-only preview, this PUT never reaches prod",
        '  const res = await fetchApi(`/api/widgets/${id}`, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(xvii-short-reason) FAILS: @stepup-path-ok suppression with a reason under 10 chars is rejected", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "hooks/use-widget-quick-edit.ts",
      [
        "async function quickEdit(id) {",
        "  // @stepup-path-ok id:widget-put ok", // reason "ok" is < 10 chars
        '  const res = await fetchApi(`/api/widgets/${id}`, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
  });

  it("(xviii) PASSES: manifest + detector happy path (id covered, manifest entry present, call site correctly marked)", () => {
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets", "API_PATH.WIDGETS"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "async function handleSave() {",
        "  // @stepup id:widget-put",
        '  const res = await fetchApi(API_PATH.WIDGETS, { method: "PUT" });',
        "  if (!res.ok) {",
        "    if (await handleStepUpError(res, trigger)) return;",
        "  }",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Check-6 decision-surface fixtures (xix–xxv).
  //
  // Check 6 iterates the cross-product `call sites × manifest ids`. Every
  // fixture above happens to run that loop with exactly ONE candidate id and a
  // single-line call site, so the loop's per-id and per-window decisions are
  // never actually discriminated — a cache that leaked id A's method onto id B,
  // or that widened a call-site window to whole-file scope, would keep the
  // suite green. These fixtures pin those decisions directly.
  //
  // Each was red-proven against a deliberately-broken copy of the guard before
  // being committed; the mutation that each one catches is named in its title.
  // ---------------------------------------------------------------------

  it("(xix) discriminates BY METHOD across two ids sharing a path token", () => {
    // Two ids, same pathTokens, different methods. The call site is a PUT, so
    // only widget-put may be reported. Red-proves a hoist that pairs one id's
    // method with another id's tokens.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
      "widget-post": { method: "POST", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeRoute(
      "widgets",
      `// @stepup id:widget-post method:POST\n${STEPUP_CALL}\n`,
    );
    // Both ids covered by properly-marked call sites.
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const a = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(a, trigger)) return;",
        "// @stepup id:widget-post",
        'const b = await fetchApi("/api/widgets", { method: "POST" });',
        "if (await handleStepUpError(b, trigger)) return;",
      ].join("\n") + "\n",
    );
    // Unmarked PUT call site: matches widget-put only.
    writeClient(
      "hooks/use-widget-quick-edit.ts",
      [
        "async function quickEdit(id) {",
        '  const res = await fetchApi(`/api/widgets/${id}`, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
    expect(stdout).toContain("widget-put");
    // The POST id must NOT be attributed to this PUT call site.
    expect(stdout).not.toContain("widget-post");
  });

  it("(xx) scopes the client marker per FILE, not globally", () => {
    // File A carries the marker; file B does not. Both call the same gated
    // path+method. Red-proves a `file_marker_ids` cache that leaks A's marker
    // into B's iteration (which would silently clear B).
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "components/widget-row.tsx",
      [
        "async function save(id) {",
        '  const res = await fetchApi(`/api/widgets/${id}`, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
    expect(stdout).toContain("widget-row.tsx");
    // The marked file must not be reported.
    expect(stdout).not.toContain("widget-card.tsx");
  });

  it("(xxi) token matching respects the word boundary (prefix id must not match its longer sibling)", () => {
    // Mirrors a real shape in the live manifest, where 12 token prefix-pairs
    // exist (e.g. apiPath.tenantBreakglass vs apiPath.tenantBreakglassById).
    // The call site uses ONLY the longer identifier, so the short id must not
    // match it. Red-proves dropping the `([^A-Za-z0-9_]|$)` suffix at :537.
    writePathsManifest({
      "breakglass-list": {
        method: "POST",
        pathTokens: ["apiPath.tenantBreakglass"],
      },
      "breakglass-by-id": {
        method: "POST",
        pathTokens: ["apiPath.tenantBreakglassById"],
      },
    });
    writeRoute(
      "tenant/breakglass",
      `// @stepup id:breakglass-list method:POST\n${STEPUP_CALL}\n`,
    );
    writeRoute(
      "tenant/breakglass/[id]",
      `// @stepup id:breakglass-by-id method:POST\n${STEPUP_CALL}\n`,
    );
    // Cover both ids with marked call sites.
    writeClient(
      "components/breakglass-panel.tsx",
      [
        "// @stepup id:breakglass-list",
        'const a = await fetchApi(apiPath.tenantBreakglass, { method: "POST" });',
        "if (await handleStepUpError(a, trigger)) return;",
        "// @stepup id:breakglass-by-id",
        'const b = await fetchApi(apiPath.tenantBreakglassById(x), { method: "POST" });',
        "if (await handleStepUpError(b, trigger)) return;",
      ].join("\n") + "\n",
    );
    // Unmarked call site referencing ONLY the longer identifier.
    writeClient(
      "hooks/use-breakglass.ts",
      [
        "async function revoke(x) {",
        '  const res = await fetchApi(apiPath.tenantBreakglassById(x), { method: "POST" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
        "",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
    expect(stdout).toContain("breakglass-by-id");
    // The shorter id is a strict prefix of the identifier actually used; the
    // word-boundary rule must keep it out of the report.
    expect(stdout).not.toContain("id 'breakglass-list'");
  });

  it("(xxii) escapes ERE metacharacters in tokens (a literal dot must not act as a wildcard)", () => {
    // Token contains a `.`; the call site contains the same string with the dot
    // replaced by `x`. Unescaped, `.` matches `x` and the site is flagged.
    // Red-proves dropping the escaping at :536.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["API_PATH.WIDGETS"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi(API_PATH.WIDGETS, { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    // `API_PATHxWIDGETS` matches the token only if the dot stays a wildcard.
    writeClient(
      "hooks/use-unrelated.ts",
      [
        "async function unrelated() {",
        '  const res = await fetchApi(API_PATHxWIDGETS, { method: "PUT" });',
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(xxiii) skips fetchApi occurrences inside comments", () => {
    // A commented-out call site (both `//` and JSDoc `*` forms) is not a real
    // call site. Red-proves dropping the comment-prefix skip at :491-494.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "hooks/use-widget-docs.ts",
      [
        "/**",
        ' * Example usage — not a real call site:',
        ' *   const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        " */",
        '// const legacy = await fetchApi("/api/widgets/y", { method: "PUT" });',
        "export const NOTE = 1;",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("(xxiv) honors the options-window upper bound (method literal at +10 is in scope)", () => {
    // The `method:` literal sits 10 lines below the fetchApi( line — the exact
    // upper edge of opt_window. Red-proves narrowing that window (e.g. merging
    // it with arg_window's +3), which would silently stop flagging this site.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "hooks/use-widget-slow-edit.ts",
      [
        "async function slowEdit(id) {", //           F-1
        "  const res = await fetchApi(", //           F+0  (call site)
        "    `/api/widgets/${id}`,", //               F+1  (token, within +3)
        "    {", //                                   F+2
        "      headers: buildHeaders(),", //          F+3
        "      credentials: 'include',", //           F+4
        "      cache: 'no-store',", //                F+5
        "      redirect: 'follow',", //               F+6
        "      referrerPolicy: 'no-referrer',", //    F+7
        "      keepalive: false,", //                 F+8
        "      mode: 'cors',", //                     F+9
        '      method: "PUT",', //                    F+10 (upper edge)
        "    },", //                                  F+11
        "  );", //
        "  return res;",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UNMARKED_CALLSITE_CANDIDATE");
    expect(stdout).toContain("use-widget-slow-edit.ts");
  });

  it("(env-guard) refuses STEPUP_CLIENT_GUARD_* overrides under CI without FIXTURE_MODE", () => {
    // Every path override can silently green this gate — pointing CLIENT_DIR at
    // an empty tree leaves nothing to scan. Under CI that can only be accidental
    // or malicious, so it must fail closed rather than report a green gate.
    // Same contract as check-gate-selftest-coverage.sh's sec-F6 guard.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    // Sanity: with the acknowledgement, this same fixture set passes.
    expect(runGuard({ CI: "true" }).exitCode).toBe(0);

    // Without it, the overrides must be refused outright.
    const denied = runGuard({ CI: "true", STEPUP_CLIENT_GUARD_FIXTURE_MODE: "" });
    expect(denied.exitCode).toBe(1);
    expect(denied.stdout).toContain("ENV_POLLUTION_GUARD");
  });

  it("(xxvi) exempt ids never raise UNMARKED_CALLSITE_CANDIDATE", () => {
    // An exempt id's own accepted call site carries no standard `@stepup id:`
    // marker by design (its recovery is custom or non-interactive). Check 6
    // must skip exempt ids entirely — otherwise every exempt id's known call
    // site is reported as a new gap. No prior fixture reaches this branch:
    // the only exempt fixture writes a client file with no fetchApi( at all.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    // Exempt via a named custom marker, which must appear in client code.
    writeFileSync(
      exemptFile,
      "widget-put   CUSTOM_WIDGET_RECOVERY  # fixture: bespoke recovery flow, no standard marker\n",
      "utf8",
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// bespoke recovery path, no @stepup marker by design",
        "const CUSTOM_WIDGET_RECOVERY = true;",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (!res.ok) showBespokeReauth();",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).not.toContain("UNMARKED_CALLSITE_CANDIDATE");
  });

  it("(xxv) honors the suppression-window lower bound (@stepup-path-ok at L-3 suppresses)", () => {
    // suppress_window spans L-3..L. A suppression comment exactly 3 lines above
    // the call must still apply. Red-proves narrowing that window.
    writePathsManifest({
      "widget-put": { method: "PUT", pathTokens: ["/api/widgets"] },
    });
    writeRoute(
      "widgets/[id]",
      `// @stepup id:widget-put method:PUT\n${STEPUP_CALL}\n`,
    );
    writeClient(
      "components/widget-card.tsx",
      [
        "// @stepup id:widget-put",
        'const res = await fetchApi("/api/widgets/x", { method: "PUT" });',
        "if (await handleStepUpError(res, trigger)) return;",
      ].join("\n") + "\n",
    );
    writeClient(
      "hooks/use-widget-quick-edit.ts",
      [
        "async function quickEdit(id) {",
        "  // @stepup-path-ok id:widget-put confirmed false positive: preview-only path, never mutates in prod", // L-3
        "  const url = buildUrl(id);", //                                                                          L-2
        "  const headers = buildHeaders();", //                                                                    L-1
        '  const res = await fetchApi(`/api/widgets/${id}`, {', //                                                  L (call site)
        '    method: "PUT",', //                                            L+1 — must stay BELOW: opt_window scans L..L+10 only
        "  });",
        "  if (!res.ok) throw new Error('failed');",
        "}",
      ].join("\n") + "\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });
});
