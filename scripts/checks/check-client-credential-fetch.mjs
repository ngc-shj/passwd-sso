#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph, no Program): a client credential must not reach a
 * server other than the one that issued it.
 *
 * ## The class
 *
 * The CLI and the extension hold bearer credentials (access/refresh tokens,
 * DPoP-bound extension tokens, the `X-*` entry credentials). They are sent to
 * the issuing server only. Three review rounds on this branch found a different
 * way for the same credential to leave: a redirect the fetch followed to
 * another origin, a token sent to a server it was not issued by, a helper that
 * attached `Authorization` on its own. See
 * docs/archive/review/share-link-expiry-grace-code-review.md.
 *
 * ## Defining primitive
 *
 * Every outbound request goes through the global `fetch`. A credential-bearing
 * request is safe from a cross-origin hop only if the fetch refuses to follow
 * redirects (`redirect: "error"`; `"manual"` for the public, credential-free
 * manifest downloads in audit-verify.ts, where the caller inspects the 3xx
 * itself). The issuer binding is enforced where `Authorization` is attached.
 * The member set is therefore derived from the primitive (the identifier
 * `fetch`), not read off files.
 *
 * ## Axis 1 — redirect (verification gate, fail-closed; cli/src + extension/src)
 *
 * Every call of the global fetch — `fetch(...)`, `globalThis|window|self.fetch(...)`
 * (also `["fetch"]`), or a call through a same-file alias (a `const` whose
 * initializer references `fetch`, e.g. `const fetchFn = callbacks.fetchImpl ??
 * fetch`) — must pass a 2nd argument that resolves to an object literal
 * (inline, or a same-scope `const` identifier initialised with one) whose
 * `redirect` property is the string literal "error" or "manual" and sits AFTER
 * every spread element (a later spread could override it). A missing or
 * unreadable init, a different value, a computed key, or `redirect` before a
 * spread is a violation. Any other reference to the identifier `fetch` (passed
 * as a value, re-assigned, destructured, shorthand) is "unclassified fetch
 * reference", so a new alias cannot slip past; the only exemption is the type
 * position `typeof fetch`, which has no runtime effect. An alias that is used
 * other than as a callee is likewise unclassified. Alias binding is by name
 * within one file (no scope analysis): a same-named local shadow is checked as
 * if it were the alias, which can only over-report.
 *
 * Control class (R49): verification — the property is checked on the call
 * itself, not inferred from a name list. The one non-verifying piece is the
 * alias set (name-based, per file).
 *
 * ## Axis 2 — Authorization (TRIPWIRE, not a boundary; extension/src only)
 *
 * A property named `Authorization` (identifier or string key, any case), a
 * `.set/.append("Authorization", …)` call, or `x["Authorization"] = …`,
 * outside the allowlist below, is a violation. This is a name-based tripwire:
 * it raises the cost of the cheap regression (a new helper that attaches the
 * bearer) and does NOT prove the issuer binding of the allowed sites.
 * Known bypasses: a computed/dynamic header name (`h[name]`), a name built by
 * concatenation, a header object passed through a helper outside the
 * allowlist that gets the name from elsewhere, `new Headers(entriesFromData)`,
 * and any non-fetch transport (XHR, WebSocket, `chrome.*` APIs). The
 * redirect axis still bounds where those requests can be re-sent to; the
 * issuer binding of the allowlisted sites is reviewed by hand.
 *
 * ## Escape hatch
 *
 * Axis 1: none — fix the call. Axis 2: the AUTHORIZATION_ALLOWLIST constant
 * below, each entry with a reason.
 *
 * Env: `CLIENT_CREDENTIAL_CLI_ROOT` (default `cli/src`) and
 * `CLIENT_CREDENTIAL_EXT_ROOT` (default `extension/src`) override the scan
 * roots, for the self-test's fixture trees. A root with no scannable file is an
 * error (a gate that examined nothing must not read as green).
 *
 * Fail-closed: a file that cannot be read or parsed is an ERROR (exit 1).
 * Exit 0 = OK, 1 = a violation or a processing error.
 */
import { Node, SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, walkSourceFiles } from "./lib/ast-project.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ROOT = process.env.CLIENT_CREDENTIAL_CLI_ROOT ?? join(REPO_ROOT, "cli/src");
const EXT_ROOT = process.env.CLIENT_CREDENTIAL_EXT_ROOT ?? join(REPO_ROOT, "extension/src");

/** Paths relative to extension/src that may attach `Authorization`. */
const AUTHORIZATION_ALLOWLIST = new Map([
  [
    "background/dpop-fetch.ts",
    "DPoP helper: sends the bearer only to the serverUrl the token was issued for, with redirect: error",
  ],
  [
    "options/App.tsx",
    "key-reset call: target issuer comes from GET_TOKEN (the token's own issuer), redirect: error",
  ],
]);

class GateIOError extends Error {}

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
const ALLOWED_REDIRECT = new Set(["error", "manual"]);

function strText(node) {
  if (!node) return null;
  const k = node.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralText();
  }
  return null;
}

function unwrap(node) {
  while (
    node &&
    (Node.isParenthesizedExpression(node) ||
      Node.isAsExpression(node) ||
      Node.isSatisfiesExpression(node) ||
      Node.isNonNullExpression(node))
  ) {
    node = node.getExpression();
  }
  return node;
}

function isInTypePosition(id) {
  return id.getFirstAncestorByKind(SyntaxKind.TypeQuery) !== undefined;
}

/** True when `node` is `globalThis|window|self` `.fetch` or `["fetch"]`. */
function isGlobalFetchMember(node) {
  if (Node.isPropertyAccessExpression(node)) {
    const obj = node.getExpression();
    return node.getName() === "fetch" && Node.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.getText());
  }
  if (Node.isElementAccessExpression(node)) {
    const obj = node.getExpression();
    return (
      strText(node.getArgumentExpression()) === "fetch" &&
      Node.isIdentifier(obj) &&
      GLOBAL_OBJECTS.has(obj.getText())
    );
  }
  return false;
}

function findConstObjectLiteral(from, name) {
  for (let scope = from.getParent(); scope; scope = scope.getParent()) {
    if (
      !Node.isBlock(scope) &&
      !Node.isSourceFile(scope) &&
      !Node.isCaseClause(scope) &&
      !Node.isDefaultClause(scope) &&
      !Node.isModuleBlock(scope)
    ) {
      continue;
    }
    for (const stmt of scope.getStatements()) {
      if (!Node.isVariableStatement(stmt)) continue;
      const list = stmt.getDeclarationList();
      if (!(list.getFlags() & 2 /* NodeFlags.Const */)) continue;
      for (const decl of list.getDeclarations()) {
        if (decl.getName() === name && decl.getNameNode().getKind() === SyntaxKind.Identifier) {
          const init = unwrap(decl.getInitializer());
          return init && Node.isObjectLiteralExpression(init) ? init : null;
        }
      }
    }
  }
  return null;
}

/** Returns a reason string if the call's init does not pin redirect, else null. */
function redirectProblem(call) {
  const args = call.getArguments();
  if (args.length < 2) return "no init argument (redirect defaults to follow)";
  let init = unwrap(args[1]);
  if (Node.isIdentifier(init)) {
    const resolved = findConstObjectLiteral(init, init.getText());
    if (!resolved) return `init \`${init.getText()}\` does not resolve to a same-scope const object literal`;
    init = resolved;
  }
  if (!Node.isObjectLiteralExpression(init)) return "init is not an object literal";
  let lastSpread = -1;
  let redirectIdx = -1;
  let redirectValue;
  init.getProperties().forEach((prop, i) => {
    if (Node.isSpreadAssignment(prop)) {
      lastSpread = i;
      return;
    }
    const nameNode = prop.getNameNode?.();
    if (!nameNode) return;
    let key = null;
    if (Node.isIdentifier(nameNode)) key = nameNode.getText();
    else if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralText();
    else if (Node.isComputedPropertyName(nameNode)) {
      const inner = strText(nameNode.getExpression());
      key = inner ?? "<computed>";
    }
    if (key === "<computed>") {
      redirectIdx = -2; // unreadable key could be `redirect`
      return;
    }
    if (key !== "redirect") return;
    redirectIdx = i;
    redirectValue = Node.isPropertyAssignment(prop) ? strText(unwrap(prop.getInitializer())) : null;
  });
  if (redirectIdx === -2) return "init has a computed property key that may override redirect";
  if (redirectIdx === -1) return "init has no `redirect` property";
  if (!ALLOWED_REDIRECT.has(redirectValue ?? "")) {
    return 'init `redirect` is not the string literal "error" or "manual"';
  }
  if (redirectIdx < lastSpread) return "`redirect` is positioned before a spread element that can override it";
  return null;
}

function scanRedirect(sf, label, findings) {
  const loc = (n) => `${label}:${n.getStartLineNumber()}`;
  // Alias set: const declarations whose initializer references `fetch`.
  const aliasNames = new Set();
  const aliasInitIds = new Set();
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    const isConst = Node.isVariableDeclarationList(decl.getParent()) && !!(decl.getParent().getFlags() & 2);
    // Only a fetch that is the VALUE of the initializer (directly, or as an
    // operand of `??`/`||`/`&&`/`?:`) makes the binding an alias. A fetch nested
    // deeper (an argument, a closure body) stays unclassified, and a call
    // (`const res = await fetch(...)`) binds a response, not an alias.
    const refs = [];
    const collect = (n) => {
      n = unwrap(n);
      if (Node.isBinaryExpression(n)) {
        const op = n.getOperatorToken().getKind();
        if (
          op === SyntaxKind.QuestionQuestionToken ||
          op === SyntaxKind.BarBarToken ||
          op === SyntaxKind.AmpersandAmpersandToken
        ) {
          collect(n.getLeft());
          collect(n.getRight());
        }
      } else if (Node.isConditionalExpression(n)) {
        collect(n.getWhenTrue());
        collect(n.getWhenFalse());
      } else if ((Node.isIdentifier(n) && n.getText() === "fetch") || isGlobalFetchMember(n)) {
        refs.push(n);
      }
    };
    collect(init);
    if (refs.length === 0) continue;
    if (isConst && Node.isIdentifier(decl.getNameNode())) {
      aliasNames.add(decl.getName());
      for (const r of refs) aliasInitIds.add(r);
    }
  }

  const classified = new Set();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = unwrap(call.getExpression());
    const isFetchCall =
      (Node.isIdentifier(callee) && (callee.getText() === "fetch" || aliasNames.has(callee.getText()))) ||
      isGlobalFetchMember(callee);
    if (!isFetchCall) continue;
    classified.add(callee);
    const problem = redirectProblem(call);
    if (problem) findings.push(`${loc(call)}: fetch call without a pinned redirect: ${problem}`);
  }

  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    if (name !== "fetch" && !aliasNames.has(name)) continue;
    if (classified.has(id) || aliasInitIds.has(id) || isInTypePosition(id)) continue;
    const parent = id.getParent();
    // The declaration name of an alias is not a reference.
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id && aliasNames.has(name)) continue;
    if (name === "fetch") {
      // `x.fetch` where x is not a global object is some other API; `{ fetch: v }` / methods are keys.
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
        if (isGlobalFetchMember(parent)) {
          if (classified.has(parent) || aliasInitIds.has(parent)) continue;
          findings.push(`${loc(id)}: unclassified fetch reference (\`${parent.getText()}\` used other than as a checked call)`);
        }
        continue;
      }
      if (
        (Node.isPropertyAssignment(parent) ||
          Node.isMethodDeclaration(parent) ||
          Node.isPropertySignature(parent) ||
          Node.isPropertyDeclaration(parent) ||
          Node.isMethodSignature(parent)) &&
        parent.getNameNode() === id
      ) {
        continue;
      }
      if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) {
        findings.push(`${loc(id)}: unclassified fetch reference (import/export of a binding named fetch)`);
        continue;
      }
    } else if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
      continue;
    } else if (
      (Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent) || Node.isMethodDeclaration(parent)) &&
      parent.getNameNode() === id
    ) {
      continue;
    }
    findings.push(
      `${loc(id)}: unclassified fetch reference (\`${name}\` is neither a checked call nor an alias initializer)`,
    );
  }
  // `globalThis.fetch` / `["fetch"]` members that are not calls or alias initializers.
  for (const m of [
    ...sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
  ]) {
    if (isGlobalFetchMember(m) && !classified.has(m) && !aliasInitIds.has(m)) {
      findings.push(`${loc(m)}: unclassified fetch reference (\`${m.getText()}\` used other than as a checked call)`);
    }
  }
}

function scanAuthorization(sf, label, rel, findings) {
  if (AUTHORIZATION_ALLOWLIST.has(rel)) return;
  const loc = (n) => `${label}:${n.getStartLineNumber()}`;
  const isAuth = (s) => s !== null && s.toLowerCase() === "authorization";
  for (const n of sf.getDescendants()) {
    if (Node.isPropertyAssignment(n) || Node.isShorthandPropertyAssignment(n) || Node.isPropertySignature(n)) {
      const nameNode = n.getNameNode();
      const key = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : Node.isStringLiteral(nameNode)
          ? nameNode.getLiteralText()
          : null;
      if (isAuth(key)) findings.push(`${loc(n)}: Authorization header property outside the allowlist`);
    } else if (Node.isCallExpression(n)) {
      const callee = n.getExpression();
      if (
        Node.isPropertyAccessExpression(callee) &&
        (callee.getName() === "set" || callee.getName() === "append") &&
        isAuth(strText(n.getArguments()[0]))
      ) {
        findings.push(`${loc(n)}: ${callee.getName()}("Authorization", …) outside the allowlist`);
      }
    } else if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const left = n.getLeft();
      if (Node.isElementAccessExpression(left) && isAuth(strText(left.getArgumentExpression()))) {
        findings.push(`${loc(n)}: Authorization header assignment outside the allowlist`);
      }
    }
  }
}

function scanRoot(project, root, labelPrefix, { authorization }) {
  const findings = [];
  const files = walkSourceFiles(root);
  if (files.length === 0) throw new GateIOError(`no scannable source files under ${root}`);
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const label = `${labelPrefix}/${rel}`;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new GateIOError(`failed to read ${label}: ${err.message}`);
    }
    let sf;
    try {
      sf = project.createSourceFile(label, text, { overwrite: true });
    } catch (err) {
      throw new GateIOError(`failed to parse ${label}: ${err.message}`);
    }
    scanRedirect(sf, label, findings);
    if (authorization) scanAuthorization(sf, label, rel, findings);
  }
  return findings;
}

function main() {
  const project = createAstProject();
  let findings;
  try {
    findings = [
      ...scanRoot(project, CLI_ROOT, "cli/src", { authorization: false }),
      ...scanRoot(project, EXT_ROOT, "extension/src", { authorization: true }),
    ];
  } catch (err) {
    if (err instanceof GateIOError) {
      console.error(`check-client-credential-fetch: ERROR: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (findings.length > 0) {
    console.error("check-client-credential-fetch: violations:");
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("check-client-credential-fetch: OK");
}

main();
