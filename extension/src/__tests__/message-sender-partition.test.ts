import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CONTENT_ALLOWED_MESSAGES,
  EXT_MSG,
  EXTENSION_PAGE_ONLY_MESSAGES,
} from "../lib/constants";

// handleMessage refuses EXTENSION_PAGE_ONLY_MESSAGES from any sender that is
// not an extension page. These tests keep the two sets a partition of the
// message types the background handles, and keep content scripts from sending
// a type the background will refuse from them. Both read the source with the
// TypeScript parser, not a text search, so formatting cannot hide a member.

const SRC = resolve(__dirname, "..");
const EXT_MSG_VALUES = new Set<string>(Object.values(EXT_MSG));

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function extMsgName(node: ts.Node): string | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "EXT_MSG"
  ) {
    return node.name.text;
  }
  return null;
}

/** The `case EXT_MSG.X:` labels of handleMessage's own switch. */
function handledMessageTypes(): string[] {
  const source = parse(join(SRC, "background/index.ts"));
  let handler: ts.FunctionDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleMessage") handler = node;
  });
  if (!handler?.body) throw new Error("handleMessage not found in background/index.ts");
  const labels: string[] = [];
  for (const statement of handler.body.statements) {
    if (!ts.isSwitchStatement(statement)) continue;
    for (const clause of statement.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      const name = extMsgName(clause.expression);
      if (name) labels.push(EXT_MSG[name as keyof typeof EXT_MSG]);
    }
  }
  return labels;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js)$/.test(entry) ? [path] : [];
  });
}

/** Every EXT_MSG value a file names: `EXT_MSG.X` or the bare string literal. */
function namedMessageTypes(path: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = extMsgName(node);
    if (name && name in EXT_MSG) found.push(EXT_MSG[name as keyof typeof EXT_MSG]);
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      EXT_MSG_VALUES.has(node.text)
    ) {
      found.push(node.text);
    }
    node.forEachChild(visit);
  };
  visit(parse(path));
  return found;
}

describe("message sender partition", () => {
  it("classifies every message type handleMessage handles exactly once", () => {
    const handled = new Set(handledMessageTypes());
    // An empty scan would make the equality below vacuous.
    expect(handled.size).toBeGreaterThan(20);

    const overlap = [...EXTENSION_PAGE_ONLY_MESSAGES].filter((t) => CONTENT_ALLOWED_MESSAGES.has(t));
    expect(overlap).toEqual([]);

    const classified = new Set([...EXTENSION_PAGE_ONLY_MESSAGES, ...CONTENT_ALLOWED_MESSAGES]);
    expect([...classified].sort()).toEqual([...handled].sort());
  });

  it("no content script names an extension-page-only message type", () => {
    // public/offscreen.js is an extension page (it sends KEEPALIVE_PING) and is
    // not scanned; everything under src/content runs in web pages.
    const files = sourceFiles(join(SRC, "content"));
    expect(files.length).toBeGreaterThan(5);

    const offending = files.flatMap((path) =>
      namedMessageTypes(path)
        .filter((type) => EXTENSION_PAGE_ONLY_MESSAGES.has(type as never))
        .map((type) => `${path.slice(SRC.length + 1)}: ${type}`),
    );
    expect(offending).toEqual([]);
  });

  it("finds the content-allowed types the content scripts do send", () => {
    // The scan must see real senders, or the test above passes on nothing.
    const named = new Set(sourceFiles(join(SRC, "content")).flatMap(namedMessageTypes));
    expect(named.has(EXT_MSG.AUTOFILL_FROM_CONTENT)).toBe(true);
    expect(named.has(EXT_MSG.CHECK_PENDING_SAVE)).toBe(true);
    expect(named.has(EXT_MSG.GET_MATCHES_FOR_URL)).toBe(true);
  });
});
