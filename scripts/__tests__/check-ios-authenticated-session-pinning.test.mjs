/**
 * Regression tests for check-ios-authenticated-session-pinning.sh.
 *
 * The guard bans raw URLSession construction in production iOS code, with a
 * single allowlisted primitive (ServerTrustService.swift). These tests pin each
 * of its distinct branches so the guard is provably able to FAIL, and assert on
 * the stable error IDENTIFIER (not just the exit code) — exit 1 alone conflates
 * three different fail branches.
 *
 * Cases are derived from the guard's ACTUAL branches, not a fixed
 * positive/negative/stale/false-positive template (a template would force a
 * vacuous case onto a blanket substring ban and hide the genuinely interesting
 * comment-false-positive limitation).
 *
 * Isolation: each case builds a throwaway iOS-shaped tree under a fresh mkdtemp
 * root and points the guard there via IOS_PINNING_CHECK_ROOT — never the repo.
 * Every tree seeds the allowlisted Shared/Network/ServerTrustService.swift WITH
 * a URLSession construction, so the allowlist-staleness clause stays green and
 * only the branch under test can fire.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../checks/check-ios-authenticated-session-pinning.sh", import.meta.url),
);

const ALLOWLISTED = "Shared/Network/ServerTrustService.swift";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ios-pinning-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(relPath, source) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source, "utf8");
}

// Seed a well-formed tree: the allowlisted primitive constructs a session, plus
// a benign production file that constructs nothing.
function seedCleanTree() {
  write(ALLOWLISTED, "let session = URLSession(configuration: cfg, delegate: d, delegateQueue: nil)\n");
  write("PasswdSSOApp/Benign.swift", "func f() { doNothingWithNetworking() }\n");
}

function run(extraEnv = {}) {
  try {
    const stdout = execFileSync("bash", [CHECKER], {
      env: { ...process.env, IOS_PINNING_CHECK_ROOT: dir, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describe("check-ios-authenticated-session-pinning", () => {
  // Asserted first: proves the harness itself isn't spuriously red before the
  // negative cases mean anything.
  it("passes on a clean tree (allowlisted construction only)", () => {
    seedCleanTree();

    const { code } = run();

    expect(code).toBe(0);
  });

  it("fails with UNPINNED_URLSESSION_CONSTRUCTION for a non-allowlisted construction", () => {
    seedCleanTree();
    write("PasswdSSOApp/Foo.swift", "let s = URLSession.shared\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  it("fails with ALLOWLIST_MISSING_FILE when the allowlisted file is absent", () => {
    // Seed a benign file so the tree exists, but omit ServerTrustService.swift.
    write("PasswdSSOApp/Benign.swift", "func f() {}\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("ALLOWLIST_MISSING_FILE");
  });

  it("fails with ALLOWLIST_STALE_ENTRY when the allowlisted file no longer constructs a session", () => {
    write(ALLOWLISTED, "func noLongerBuildsASession() {}\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("ALLOWLIST_STALE_ENTRY");
  });

  it("fails closed with PINNING_CHECK_ROOT_INVALID for a nonexistent override root", () => {
    const { code, stderr } = run({
      IOS_PINNING_CHECK_ROOT: join(dir, "does-not-exist"),
    });

    expect(code).toBe(1);
    expect(stderr).toContain("PINNING_CHECK_ROOT_INVALID");
  });

  // Swift treats a block comment as whitespace, so `URLSession/* x */.shared` is
  // a valid construction. The guard tolerates whitespace/block-comment filler
  // between the tokens (matched on RAW source, nothing stripped), so this is
  // caught.
  it("fails on a comment-split construction (URLSession/* */.shared)", () => {
    seedCleanTree();
    write("PasswdSSOApp/Split.swift", "let s = URLSession/* bypass */.shared\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // Whitespace between the type and the member is also valid Swift and must not
  // slip past the guard.
  it("fails on a whitespace-split construction (URLSession .shared)", () => {
    seedCleanTree();
    write("PasswdSSOApp/Spaced.swift", "let s = URLSession .shared\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // Fail-CLOSED design (roadmap review): the guard matches raw source and does
  // NOT strip comments/strings, because a partial lexer that removed them would
  // delete real code it misread and let a construction slip through (fail-open).
  // The two cases below are exactly the bypasses a comment-stripping normalizer
  // opened up; matching raw source closes them.

  // A `//` inside a string literal is NOT a comment in Swift, so a construction
  // later on the same line is real. A normalizer that treated `//` as a line
  // comment would delete it — the guard must not.
  it("fails on a construction after a string containing // on the same line", () => {
    seedCleanTree();
    write(
      "PasswdSSOApp/UrlString.swift",
      'let endpoint = "https://example.test"; let s = URLSession.shared\n',
    );

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // Swift allows nested block comments; a non-greedy `/\*.*?\*/` strip would end
  // at the first `*/` and leave `.shared` exposed as (mis-parsed) code, but a
  // stripper is exactly what we avoid — raw-source matching catches this too.
  it("fails on a construction with a nested block comment between tokens", () => {
    seedCleanTree();
    write(
      "PasswdSSOApp/Nested.swift",
      "let s = URLSession/* outer /* nested */ outer */.shared\n",
    );

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // A block comment split across lines between the tokens is still a single
  // valid construction in Swift; the /s (dotall) match must cross the newline.
  it("fails on a construction with a multi-line block comment between tokens", () => {
    seedCleanTree();
    write(
      "PasswdSSOApp/Multiline.swift",
      "let s = URLSession/* first line\n second line */.shared\n",
    );

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // Swift lets an identifier be backtick-escaped: `` `URLSession` `` and
  // `` .`shared` `` are the SAME identifiers, so these are real constructions.
  it("fails on a backtick-escaped type (`URLSession`.shared)", () => {
    seedCleanTree();
    write("PasswdSSOApp/BacktickType.swift", "let s = `URLSession`.shared\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  it("fails on a backtick-escaped member (URLSession.`shared`)", () => {
    seedCleanTree();
    write("PasswdSSOApp/BacktickMember.swift", "let s = URLSession.`shared`\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });

  // The guard must NOT flag URLSession used purely as a TYPE (annotation,
  // parameter, return type) — the pinned design injects the session by
  // constructor, so type references to URLSession are legitimate and pervasive.
  // Flagging them would force the 30+ real type references into the allowlist
  // and make the guard meaningless.
  it("passes on a URLSession type annotation (no construction)", () => {
    seedCleanTree();
    write("PasswdSSOApp/TypeRef.swift", "final class C {\n  private let session: URLSession\n  init(session: URLSession) { self.session = session }\n}\n");

    const { code } = run();

    expect(code).toBe(0);
  });

  it("passes on sibling types like URLSessionConfiguration / URLSessionTask", () => {
    seedCleanTree();
    write("PasswdSSOApp/Sibling.swift", "let cfg = URLSessionConfiguration.default\nfunc f(t: URLSessionTask) {}\n");

    const { code } = run();

    expect(code).toBe(0);
  });

  // ACCEPTED GAP (fail-open, documented): construction through a typealias is
  // NOT caught — resolving the alias needs semantic analysis a textual guard
  // cannot do. This test PINS the current (miss) behavior so a future
  // SwiftSyntax upgrade has a regression target; it is not a bug to "fix" here.
  it("does NOT catch construction via a typealias (accepted gap, pins current behavior)", () => {
    seedCleanTree();
    write("PasswdSSOApp/Aliased.swift", "typealias UnsafeSession = URLSession\nlet s = UnsafeSession.shared\n");

    const { code } = run();

    expect(code).toBe(0);
  });

  // Accepted false POSITIVE (the safe direction): a URLSession mention that
  // lives ONLY inside a comment is flagged, because the guard does not parse
  // comments. This is the deliberate cost of fail-closed raw-source matching.
  it("flags a URLSession mention that appears only inside a comment (accepted false positive)", () => {
    seedCleanTree();
    write("PasswdSSOApp/Commented.swift", "// historically used URLSession.shared here\nfunc f() {}\n");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("UNPINNED_URLSESSION_CONSTRUCTION");
  });
});
