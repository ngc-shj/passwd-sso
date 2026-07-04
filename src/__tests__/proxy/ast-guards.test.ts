import { describe, it, expect } from "vitest";
import {
  parseRouteSource,
  hasRealCall,
  hasCallWithObjectFlag,
  limiterFlagFlowsToChecker,
  matchesInCodeText,
} from "./ast-guards";

// The real form every operator-gated route uses: a module-scope fail-closed
// limiter const flowing into an in-handler checkRateLimitOrFail call.
const REAL_ROUTE = `
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
const rateLimiter = createRateLimiter({
  windowMs: 1000,
  max: 1,
  failClosedOnRedisError: true,
});
async function handlePOST(req) {
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: "rl:maintenance:x",
  });
  if (blocked) return blocked;
}
`;

const parse = (src: string) => parseRouteSource(src, "test.ts");

describe("parseRouteSource — fail-closed (I-C3-4)", () => {
  it("throws on truncated / malformed source", () => {
    expect(() => parse("const x = createRateLimiter({ @@@ broken")).toThrow();
  });

  it("does not throw on valid source", () => {
    expect(() => parse(REAL_ROUTE)).not.toThrow();
  });
});

describe("hasRealCall", () => {
  it("true for a real call expression", () => {
    expect(hasRealCall(parse(REAL_ROUTE), "createRateLimiter")).toBe(true);
  });

  it("false when the callee appears only in a comment (decoy)", () => {
    const src = `// createRateLimiter( is documented here\nconst x = 1;`;
    expect(hasRealCall(parse(src), "createRateLimiter")).toBe(false);
  });

  it("false when the callee appears only in a string literal (decoy)", () => {
    const src = `const msg = "call createRateLimiter( to build one";`;
    expect(hasRealCall(parse(src), "createRateLimiter")).toBe(false);
  });

  it("false for an import specifier with no call (I-C3-1)", () => {
    const src = `import { createRateLimiter } from "@/lib/security/rate-limit";`;
    expect(hasRealCall(parse(src), "createRateLimiter")).toBe(false);
  });

  it("true for a member call (a.b.checkRateLimitOrFail())", () => {
    const src = `svc.limits.checkRateLimitOrFail({ req });`;
    expect(hasRealCall(parse(src), "checkRateLimitOrFail")).toBe(true);
  });
});

describe("hasCallWithObjectFlag", () => {
  const flag = "failClosedOnRedisError";

  it("true when the flag is a real property of the call's object arg", () => {
    expect(hasCallWithObjectFlag(parse(REAL_ROUTE), "createRateLimiter", flag, true)).toBe(true);
  });

  it("false when the property is false (I-C3-2a)", () => {
    const src = `const r = createRateLimiter({ failClosedOnRedisError: false });`;
    expect(hasCallWithObjectFlag(parse(src), "createRateLimiter", flag, true)).toBe(false);
  });

  it("false when the flag is on a different call (I-C3-2b)", () => {
    const src = `const r = createRateLimiter({ max: 1 });\nconst o = other({ failClosedOnRedisError: true });`;
    expect(hasCallWithObjectFlag(parse(src), "createRateLimiter", flag, true)).toBe(false);
  });

  it("false when the first arg is a variable, not an object literal (I-C3-2c)", () => {
    const src = `const config = { failClosedOnRedisError: true };\nconst r = createRateLimiter(config);`;
    expect(hasCallWithObjectFlag(parse(src), "createRateLimiter", flag, true)).toBe(false);
  });

  it("true for a multi-line / reformatted object literal (I-C3-2d)", () => {
    const src = `const r = createRateLimiter({\n  failClosedOnRedisError:\n    true,\n});`;
    expect(hasCallWithObjectFlag(parse(src), "createRateLimiter", flag, true)).toBe(true);
  });

  it("false when the flag is present only in a comment (I-C3-5 gap-closure proof)", () => {
    // This exact input passed the OLD /failClosedOnRedisError:\s*true/.test(source)
    // (matched the comment) and MUST fail the AST check — the permanent regression
    // guard proving the lexical gap is closed.
    const src = `const r = createRateLimiter({ prefix: "x" });\n// failClosedOnRedisError: true`;
    expect(hasCallWithObjectFlag(parse(src), "createRateLimiter", flag, true)).toBe(false);
  });
});

describe("limiterFlagFlowsToChecker (S2 dataflow link)", () => {
  it("true when the fail-closed const limiter flows into checkRateLimitOrFail", () => {
    expect(limiterFlagFlowsToChecker(parse(REAL_ROUTE))).toBe(true);
  });

  it("true for an inline createRateLimiter in the limiter position", () => {
    const src = `
async function h(req) {
  await checkRateLimitOrFail({ limiter: createRateLimiter({ failClosedOnRedisError: true }) });
}`;
    expect(limiterFlagFlowsToChecker(parse(src))).toBe(true);
  });

  it("false when checker consumes a different, flagless limiter (I-C3-6 decoy)", () => {
    // A decoy fail-closed limiter exists, but the handler passes a different
    // limiter that lacks the flag — hasCallWithObjectFlag alone would pass here.
    const src = `
const decoy = createRateLimiter({ failClosedOnRedisError: true });
const other = createRateLimiter({ max: 1 });
async function h(req) {
  await checkRateLimitOrFail({ limiter: other, key: "x" });
}`;
    const sf = parse(src);
    expect(hasCallWithObjectFlag(sf, "createRateLimiter", "failClosedOnRedisError", true)).toBe(true);
    expect(limiterFlagFlowsToChecker(sf)).toBe(false);
  });
});

describe("matchesInCodeText", () => {
  const WRITE = /\btx\.[A-Za-z]+\.(create|delete)\(/;

  it("true when the pattern matches real code", () => {
    const src = `async function h() { await tx.mcpClient.create({ data }); }`;
    expect(matchesInCodeText(parse(src), WRITE)).toBe(true);
  });

  it("false when the match is only inside a comment", () => {
    const src = `// tx.mcpClient.delete( is intentionally not called here\nconst x = 1;`;
    expect(matchesInCodeText(parse(src), WRITE)).toBe(false);
  });

  it("false when the match is only inside a template fixed-text span", () => {
    const src = "const s = `tx.mcpClient.delete( is documented`;";
    expect(matchesInCodeText(parse(src), WRITE)).toBe(false);
  });

  it("true when the match is inside a ${} interpolation (real code)", () => {
    const src = "const s = `${await tx.mcpClient.delete({ where })}`;";
    expect(matchesInCodeText(parse(src), WRITE)).toBe(true);
  });

  it("does not blank regex-literal bodies as if they were strings (I-C3-3)", () => {
    // A regex literal is code, not a StringLiteral node, so its text is not
    // blanked. Assert the identifier inside it survives (the fixed-text blanker
    // must not have swallowed it).
    const src = `const re = /createRateLimiter/;`;
    expect(matchesInCodeText(parse(src), /createRateLimiter/)).toBe(true);
  });

  it("still matches real code after a comment apostrophe (F1 regression fixture)", () => {
    // A naive regex string-blanker treats the comment apostrophe as a string
    // opener and swallows the following real create() line. AST ranges do not.
    const src = `// scope deletion to the user's tenant\nasync function h() { await tx.mcpClient.create({ data }); }`;
    expect(matchesInCodeText(parse(src), WRITE)).toBe(true);
  });
});
