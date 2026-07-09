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

function runGuard() {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      STEPUP_CLIENT_GUARD_API_DIR: apiDir,
      STEPUP_CLIENT_GUARD_CLIENT_DIR: clientDir,
      STEPUP_CLIENT_GUARD_PATH_ROOT: root,
      STEPUP_CLIENT_GUARD_EXEMPT_FILE: exemptFile,
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stepup-client-guard-"));
  apiDir = join(root, "src", "app", "api");
  clientDir = join(root, "src");
  exemptFile = join(root, "exempt.txt");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-step-up-client-coverage.sh", () => {
  it("(i) PASSES: server marker + client marker + branch in window", () => {
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
    writeRoute(
      "mcp/authorize",
      `// @stepup id:mcp-authorize-get method:GET\n${STEPUP_CALL_SESSION}\n`,
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
    writeRoute(
      "mobile/authorize",
      `// @stepup id:mobile-authorize-get method:GET\n${STEPUP_CALL_SESSION}\n`,
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
});
