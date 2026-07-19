/**
 * Self-test for scripts/checks/classify-fail-closed-test.mjs — the AST
 * classifier behind check-fail-closed-routes-have-test.sh.
 *
 * The classifier exists precisely because text matching cannot distinguish
 * code from comments/labels; these cases pin that distinction per field
 * (import / calls / mock / redis) so a regression back toward text-shaped
 * detection fails here, independently of the gate's own fixture suite.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CLASSIFIER = join(REPO_ROOT, "scripts/checks/classify-fail-closed-test.mjs");

function classify(content, filename = "route.test.ts") {
  const dir = mkdtempSync(join(tmpdir(), "classify-fc-"));
  const file = join(dir, filename);
  writeFileSync(file, content, "utf8");
  try {
    const r = spawnSync("node", [CLASSIFIER, file], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const record = r.stdout.trim().split("\t")[1];
    const fields = {};
    for (const part of record.split(" ")) {
      const [k, v] = part.split("=");
      fields[k] = Number(v);
    }
    return fields;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Same as `classify` but returns the raw spawnSync result instead of
// asserting status=0 — for cases that are expected to fail-loud (exit 1).
function classifyExpectFailure(content, filename = "route.test.ts") {
  const dir = mkdtempSync(join(tmpdir(), "classify-fc-"));
  const file = join(dir, filename);
  writeFileSync(file, content, "utf8");
  try {
    return spawnSync("node", [CLASSIFIER, file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IMPORT_LINE = `import { describe, it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
`;

describe("classify-fail-closed-test.mjs", () => {
  it("recognizes a genuine helper contract test (import + calls inside it(), no mock)", () => {
    const f = classify(`${IMPORT_LINE}
it("case 1", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
it("case 2", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f).toMatchObject({ exists: 1, import: 1, calls: 2, mock: 0, redis: 1 });
  });

  it("counts calls under it.each(...)(...) and it.only(...)", () => {
    const f = classify(`${IMPORT_LINE}
it.each([1, 2])("case %s", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
it.only("focused", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f.calls).toBe(2);
  });

  it("counts assertRedisFailClosedSilentDrop as a helper call (silent-drop tier)", () => {
    const f = classify(`import { it } from "vitest";
import { assertRedisFailClosedSilentDrop } from "@/__tests__/helpers/fail-closed";
it("silent drop", async () => {
  await assertRedisFailClosedSilentDrop({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f).toMatchObject({ import: 1, calls: 1 });
  });

  it("counts assertRedisFailClosedResult as a helper call (direct-result tier)", () => {
    const f = classify(`import { it, vi } from "vitest";
import { assertRedisFailClosedResult } from "@/__tests__/helpers/fail-closed";
it("direct result", async () => {
  const limiter = { check: vi.fn(async () => ({ allowed: false, redisErrored: true })) };
  await assertRedisFailClosedResult({ limiter, key: "k" });
});
`);
    expect(f).toMatchObject({ import: 1, calls: 1 });
  });

  it("counts DISTINCT limiter args (two distinct → distinct=2)", () => {
    const f = classify(`import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const a = {}; const b = {};
it("1", async () => { await assertRedisFailClosed({ limiter: a, failure: { allowed: false, redisErrored: true } }); });
it("2", async () => { await assertRedisFailClosed({ limiter: b, failure: { allowed: false, redisErrored: true } }); });
`);
    expect(f).toMatchObject({ calls: 2, distinct: 2 });
  });

  it("counts the SAME limiter twice as ONE distinct (calls=2, distinct=1)", () => {
    const f = classify(`import { it } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const a = {};
it("1", async () => { await assertRedisFailClosed({ limiter: a, failure: { allowed: false, redisErrored: true } }); });
it("2", async () => { await assertRedisFailClosed({ limiter: a, failure: { allowed: false, redisErrored: true } }); });
`);
    expect(f).toMatchObject({ calls: 2, distinct: 1 });
  });

  it("flags a FAKE limiter passed to assertRedisFailClosedResult (resultfake=1)", () => {
    const f = classify(`import { it, vi } from "vitest";
import { assertRedisFailClosedResult } from "@/__tests__/helpers/fail-closed";
it("x", async () => {
  const limiter = { check: vi.fn() };
  await assertRedisFailClosedResult({ limiter, key: "k" });
});
`);
    expect(f.resultfake).toBe(1);
  });

  it("does NOT flag a PRODUCTION-import limiter passed to assertRedisFailClosedResult (resultfake=0)", () => {
    const f = classify(`import { it } from "vitest";
import { assertRedisFailClosedResult } from "@/__tests__/helpers/fail-closed";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
it("x", async () => {
  await assertRedisFailClosedResult({ limiter: v1ApiKeyLimiter, key: "k" });
});
`);
    expect(f.resultfake).toBe(0);
  });

  it("counts an ALIAS import call by symbol (import binding, not name text)", () => {
    const f = classify(`import { it } from "vitest";
import { assertRedisFailClosed as assertFailClosed } from "@/__tests__/helpers/fail-closed";
it("aliased", async () => {
  await assertFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f).toMatchObject({ import: 1, calls: 1 });
  });

  it("does NOT count a call parked in a function no test invokes (execution binding)", () => {
    const f = classify(`${IMPORT_LINE}
async function neverCalled() {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
}
it("placeholder", () => { expect(true).toBe(true); });
`);
    expect(f).toMatchObject({ import: 1, calls: 0 });
  });

  it("does NOT count a top-level call outside any test callback", () => {
    const f = classify(`${IMPORT_LINE}
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
`);
    expect(f.calls).toBe(0);
  });

  it("does NOT count calls inside it.skip / test.skip", () => {
    const f = classify(`${IMPORT_LINE}
it.skip("skipped", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f.calls).toBe(0);
  });

  it("does NOT count calls inside a describe.skip suite", () => {
    const f = classify(`${IMPORT_LINE}
describe.skip("suite", () => {
  it("inside skipped suite", async () => {
    await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
  });
});
`);
    expect(f.calls).toBe(0);
  });

  it("does NOT count a shadowing local function with the helper's name", () => {
    const f = classify(`${IMPORT_LINE}
it("shadowed", async () => {
  const assertRedisFailClosed = async () => undefined;
  await assertRedisFailClosed();
});
`);
    expect(f).toMatchObject({ import: 1, calls: 0 });
  });

  it("does NOT count a call registered via a fake local `it` (vitest symbol binding)", () => {
    const f = classify(`import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
const it = (_name, _callback) => undefined;
it("not a vitest test", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f).toMatchObject({ import: 1, calls: 0 });
  });

  it("counts a vitest ALIAS registration (it as vitestIt)", () => {
    const f = classify(`import { it as vitestIt } from "vitest";
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
vitestIt("real", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f.calls).toBe(1);
  });

  it("does NOT count calls under it.skipIf(...) / it.runIf(...) (modifier allowlist)", () => {
    const f = classify(`${IMPORT_LINE}
it.skipIf(true)("conditionally skipped", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
it.runIf(false)("conditionally run", async () => {
  await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
});
`);
    expect(f.calls).toBe(0);
  });

  it("does NOT count calls inside a describe.skipIf(...) suite", () => {
    const f = classify(`${IMPORT_LINE}
describe.skipIf(true)("suite", () => {
  it("inside conditionally skipped suite", async () => {
    await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
  });
});
`);
    expect(f.calls).toBe(0);
  });

  it("documented residual: a call in a dead branch of a RUNNING test still counts", () => {
    // Static reachability inside an executing callback is out of scope; this
    // case pins the boundary so a behavior change here is a conscious one.
    const f = classify(`${IMPORT_LINE}
it("dead branch", async () => {
  if (false) {
    await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
  }
});
`);
    expect(f.calls).toBe(1);
  });

  it("ignores import + call inside a block comment (calls=0, import=0)", () => {
    const f = classify(`/*
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
*/
it("placeholder", () => {});
`);
    expect(f).toMatchObject({ import: 0, calls: 0, redis: 0 });
  });

  it("ignores redisErrored in a describe label / string literal (redis=0)", () => {
    const f = classify(`describe("rate limiting (redisErrored)", () => {
  it("redisErrored", () => { expect(true).toBe(true); });
});
const s = "redisErrored";
`);
    expect(f.redis).toBe(0);
  });

  it("counts redisErrored as code: property assignment, property access, destructuring", () => {
    expect(classify(`const rl = { allowed: false, redisErrored: true };\n`).redis).toBe(1);
    expect(classify(`if (rl.redisErrored) { throw new Error("x"); }\n`).redis).toBe(1);
    expect(classify(`const { redisErrored } = rl;\n`).redis).toBe(1);
  });

  it("flags vi.mock of the rate-limit-audit module (mock=1)", () => {
    const f = classify(`vi.mock("@/lib/security/rate-limit-audit", () => ({ emitRateLimitFailClosed: vi.fn() }));\n`);
    expect(f.mock).toBe(1);
  });

  it("does not flag vi.mock of an unrelated module (mock=0)", () => {
    const f = classify(`vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn() }));\n`);
    expect(f.mock).toBe(0);
  });

  it("flags a checkRateLimitOrFail property stub and the mockCheckRateLimitOrFail identifier (mock=1)", () => {
    expect(classify(`const m = { checkRateLimitOrFail: vi.fn() };\n`).mock).toBe(1);
    expect(classify(`mockCheckRateLimitOrFail.mockResolvedValueOnce(null);\n`).mock).toBe(1);
  });

  it("does not flag the helper import name mentioned only in comments (mock stays 0, text-shape guard)", () => {
    const f = classify(`// mockCheckRateLimitOrFail was removed here (T1); production mapping runs.\nconst x = 1;\n`);
    expect(f.mock).toBe(0);
  });

  it("reports a missing file as exists=0 with all fields zero", () => {
    const r = spawnSync("node", [CLASSIFIER, "/nonexistent/route.test.ts"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("exists=0 import=0 calls=0 mock=0 redis=0");
  });

  it("exits 1 when invoked without arguments (fail closed, no silent empty output)", () => {
    const r = spawnSync("node", [CLASSIFIER], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });

  // C6 hardening (Round 1 M6 + Round 2 S2-1/S2-2): RECALL-first `vi`
  // resolution, vi.doMock, specifier normalization, dynamic-specifier
  // fail-loud, and .tsx virtual-path parsing.
  describe("C6 hardening: vi resolution + doMock + specifier normalization", () => {
    it("flags a stub via the GLOBAL `vi` (no vitest import — globals: true precedent, mock=1)", () => {
      const f = classify(`it("stub", () => {
  vi.mock("@/lib/security/rate-limit-audit", () => ({}));
});
`);
      expect(f.mock).toBe(1);
    });

    it("flags a stub via a NAMESPACE `vi` (import * as V from \"vitest\"; V.vi.doMock(...), mock=1)", () => {
      const f = classify(`import * as V from "vitest";
V.vi.doMock("@/lib/security/rate-limit-audit", () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("flags a stub via an ALIASED named `vi` (import { vi as viz }; viz.mock(...), mock=1)", () => {
      const f = classify(`import { vi as viz } from "vitest";
viz.mock("@/lib/security/rate-limit-audit", () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("flags a stub via an ALIASED named `vi` using doMock (viz.doMock(...), mock=1)", () => {
      const f = classify(`import { vi as viz } from "vitest";
viz.doMock("@/lib/security/rate-limit-audit", () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("fails loud (nonzero exit) when a LOCAL declaration shadows the `vi` binding", () => {
      const r = classifyExpectFailure(`it("stub", () => {
  const vi = { mock: () => {} };
  vi.mock("@/lib/security/rate-limit-audit", () => ({}));
});
`);
      expect(r.status).not.toBe(0);
    });

    it("flags a RELATIVE specifier that resolves to the mapping module (mock=1)", () => {
      const f = classify(`import { vi } from "vitest";
vi.mock("../../../lib/security/rate-limit-audit", () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("flags vi.doMock the same as vi.mock (mock=1)", () => {
      const f = classify(`import { vi } from "vitest";
vi.doMock("@/lib/security/rate-limit-audit", () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("flags vi.mock(import(\"<spec>\")) — vitest 3 typed form (mock=1)", () => {
      const f = classify(`import { vi } from "vitest";
vi.mock(import("@/lib/security/rate-limit-audit"), () => ({}));
`);
      expect(f.mock).toBe(1);
    });

    it("flags a DYNAMIC (non-literal) mock specifier as dynspec=1, NOT a silent mock=0 pass", () => {
      const f = classify(`import { vi } from "vitest";
const m = "@/lib/security/rate-limit-audit";
vi.doMock(m, () => ({}));
`);
      expect(f).toMatchObject({ mock: 0, dynspec: 1 });
    });

    it("parses a .tsx file with JSX and still flags the stub (mock=1, no CLASSIFIER_FAILURE)", () => {
      const f = classify(
        `import { vi } from "vitest";
vi.mock("@/lib/security/rate-limit-audit", () => ({}));
it("renders", () => {
  const el = <div>hello</div>;
});
`,
        "component.test.tsx",
      );
      expect(f.mock).toBe(1);
    });
  });
});
