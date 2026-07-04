/**
 * AST-based matchers for route-policy security guards (test support).
 *
 * Promotes the lexical (`source.includes(...)` / `regex.test(source)`) guards in
 * route-policy-manifest.test.ts to AST matching, so a required security call
 * hidden in a comment, string literal, or unused import can no longer satisfy a
 * guard. Uses ts-morph (already a dependency; precedent:
 * scripts/check-state-mutation-centralization.ts). Test-support only — colocated
 * with the consuming test, NOT under src/lib.
 *
 * fail-closed: ts-morph is a RECOVERING parser — createSourceFile does NOT throw
 * on malformed source (it returns a partial AST whose surviving call nodes would
 * still satisfy an existence check). parseRouteSource therefore inspects
 * parseDiagnostics and throws, so a syntactically broken route surfaces as a test
 * failure rather than a silent green. parseDiagnostics is populated by the parser
 * alone — no Program / type resolution / generated Prisma client needed.
 */
import { Node, Project, SyntaxKind } from "ts-morph";
import type { CallExpression, ObjectLiteralExpression, SourceFile } from "ts-morph";

const project = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
});

// `parseDiagnostics` is a real property the parser populates on every
// ts.SourceFile, but TypeScript marks it @internal so it is absent from the
// public type. Reading it needs no Program / type resolution (unlike
// getPreEmitDiagnostics, which would pull generated types and violate NF-R2), so
// we narrow the compiler node to just this field rather than casting to `any`.
type WithParseDiagnostics = { parseDiagnostics?: ReadonlyArray<unknown> };

export function parseRouteSource(source: string, virtualPath: string): SourceFile {
  const sf = project.createSourceFile(virtualPath, source, { overwrite: true });
  const diagnostics = (sf.compilerNode as unknown as WithParseDiagnostics).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    throw new Error(`parseRouteSource: ${virtualPath} has parse diagnostics`);
  }
  return sf;
}

// The callee text of a CallExpression: bare identifier (`f(`) or the trailing
// property name of a member call (`a.b.f(` → "f"). Import specifiers and
// comment/string occurrences are not CallExpression nodes, so they never match.
function calleeName(call: CallExpression): string {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return expr.getText();
}

function callsTo(sf: SourceFile, name: string): CallExpression[] {
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeName(call) === name);
}

export function hasRealCall(sf: SourceFile, name: string): boolean {
  return callsTo(sf, name).length > 0;
}

// True iff some call to `name` passes an object literal whose `flag` property is
// the boolean literal `value`. A non-object first argument (e.g. a variable) is
// not provable → false (guard fails closed for that route).
function objectFlagIs(obj: ObjectLiteralExpression, flag: string, value: boolean): boolean {
  const prop = obj.getProperty(flag);
  if (!prop || !Node.isPropertyAssignment(prop)) return false;
  const init = prop.getInitializer();
  return init?.getText() === String(value);
}

export function hasCallWithObjectFlag(
  sf: SourceFile,
  name: string,
  flag: string,
  value: boolean,
): boolean {
  return callsTo(sf, name).some((call) => {
    const arg0 = call.getArguments()[0];
    return arg0 !== undefined && Node.isObjectLiteralExpression(arg0) && objectFlagIs(arg0, flag, value);
  });
}

// Does the object passed as `createRateLimiter`'s first argument carry
// failClosedOnRedisError: true?
function isFailClosedLimiterCall(call: CallExpression): boolean {
  if (calleeName(call) !== "createRateLimiter") return false;
  const arg0 = call.getArguments()[0];
  return (
    arg0 !== undefined &&
    Node.isObjectLiteralExpression(arg0) &&
    objectFlagIs(arg0, "failClosedOnRedisError", true)
  );
}

/**
 * Closes the guard1 dataflow residual: verifies the fail-closed limiter is the
 * one the handler actually consumes, not merely that a fail-closed
 * createRateLimiter call and a checkRateLimitOrFail call both exist somewhere.
 *
 * True iff a checkRateLimitOrFail({ limiter: L }) call has an L that resolves —
 * within the same file — to a createRateLimiter({ ... failClosedOnRedisError:
 * true ... }) call: either L is that call inline, or L is an identifier bound by
 * a `const L = createRateLimiter({...})` declaration in the file.
 */
export function limiterFlagFlowsToChecker(sf: SourceFile): boolean {
  return callsTo(sf, "checkRateLimitOrFail").some((call) => {
    const arg0 = call.getArguments()[0];
    if (arg0 === undefined || !Node.isObjectLiteralExpression(arg0)) return false;
    const limiterProp = arg0.getProperty("limiter");
    if (!limiterProp || !Node.isPropertyAssignment(limiterProp)) return false;
    const limiter = limiterProp.getInitializer();
    if (!limiter) return false;

    if (Node.isCallExpression(limiter)) return isFailClosedLimiterCall(limiter);

    if (Node.isIdentifier(limiter)) {
      const name = limiter.getText();
      return sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((decl) => {
        if (decl.getName() !== name) return false;
        const init = decl.getInitializer();
        return init !== undefined && Node.isCallExpression(init) && isFailClosedLimiterCall(init);
      });
    }
    return false;
  });
}

// Blank comment ranges and string / template fixed-text spans (char-for-char, so
// offsets and line numbers are preserved), then test `re` against code text only.
// `${expr}` interpolation code, regex-literal bodies, and identifiers stay
// visible — an interpolated `tx.x.delete(` IS real executed code. Ranges come
// from AST/scanner nodes, NEVER from independent regex passes: a comment
// apostrophe (`user's tenant`) breaks single-pass string-blanking regexes and
// would swallow the following real code line.
export function matchesInCodeText(sf: SourceFile, re: RegExp): boolean {
  const chars = sf.getFullText().split("");

  const blank = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };

  for (const node of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    blank(node.getStart(), node.getEnd());
  }
  for (const node of sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    blank(node.getStart(), node.getEnd());
  }
  // Template literal fixed-text spans (head/middle/tail) — the ${expr} between
  // them is a separate expression node and stays visible.
  const templateKinds = [
    SyntaxKind.TemplateHead,
    SyntaxKind.TemplateMiddle,
    SyntaxKind.TemplateTail,
  ];
  for (const kind of templateKinds) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      blank(node.getStart(), node.getEnd());
    }
  }
  // Comment ranges (leading + trailing) across all descendants, deduped by start.
  const seen = new Set<number>();
  for (const node of sf.getDescendants()) {
    for (const range of [...node.getLeadingCommentRanges(), ...node.getTrailingCommentRanges()]) {
      const start = range.getPos();
      if (seen.has(start)) continue;
      seen.add(start);
      blank(start, range.getEnd());
    }
  }

  return re.test(chars.join(""));
}
