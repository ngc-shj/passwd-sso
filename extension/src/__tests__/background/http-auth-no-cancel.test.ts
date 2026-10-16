import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// C4 forbidden pattern: background/http-auth.ts never answers a challenge with
// the BlockingResponse field that blocks the request, which would take away the
// user's own manual login. Read with the TypeScript parser, so formatting,
// shorthand, computed keys and string-keyed access cannot hide it; comments are
// not code and are not matched.

const FORBIDDEN = "cancel";

function findings(source: string): string[] {
  const file = ts.createSourceFile("subject.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${line + 1}: ${what}`);
  };
  const isForbiddenName = (name: ts.PropertyName): boolean => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === FORBIDDEN;
    if (ts.isComputedPropertyName(name)) {
      return ts.isStringLiteralLike(name.expression) && name.expression.text === FORBIDDEN;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && isForbiddenName(node.name)) at(node, "property");
    else if (ts.isShorthandPropertyAssignment(node) && node.name.text === FORBIDDEN) at(node, "shorthand");
    else if (ts.isPropertyAccessExpression(node) && node.name.text === FORBIDDEN) at(node, "property access");
    else if (ts.isStringLiteralLike(node) && node.text === FORBIDDEN) at(node, "string literal");
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

describe("http-auth.ts never cancels a challenge", () => {
  it("the subject file has no cancel property, access or literal", () => {
    const path = resolve(__dirname, "../../background/http-auth.ts");
    const source = readFileSync(path, "utf8");
    // The scan read the real file, not an empty one.
    expect(source).toContain("export async function handleAuthRequired");
    expect(findings(source)).toEqual([]);
  });

  describe("self-test", () => {
    it.each([
      ["a property", "callback({ cancel: true });"],
      ["a shorthand property", "const cancel = true; callback({ cancel });"],
      ["a string-keyed property", 'callback({ "cancel": true });'],
      ["a computed property", 'callback({ ["cancel"]: true });'],
      ["an element access", 'const r: Record<string, boolean> = {}; r["cancel"] = true; callback(r);'],
      ["a property access", "const r = {} as { cancel?: boolean }; r.cancel = true; callback(r);"],
    ])("finds %s", (_name, source) => {
      expect(findings(source).length).toBeGreaterThan(0);
    });

    it("finds nothing in a clean answer or a comment", () => {
      expect(
        findings("// never cancel: Chrome shows its dialog\ncallback({ authCredentials: { username, password } }); callback({});"),
      ).toEqual([]);
    });
  });
});
