#!/usr/bin/env node
/**
 * CI guard: every path that serves a share link decides creator admission
 * (#990, docs/archive/review/departed-member-share-links-plan.md C5).
 *
 * The rule lives in the SQL function share_creator_admitted(uuid). A serve path
 * applies it twice: a pre-check beside its revoked check (isShareCreatorAdmitted
 * from @/lib/share/share-admission), and the function call inside each
 * conditional view-count UPDATE. Derived from the code:
 *
 * 1. STATEMENTS. Every tagged $executeRaw / $queryRaw whose literal text names
 *    `password_shares` and `view_count` contains `share_creator_admitted(` in
 *    its literal text.
 *
 * 2. SERVE GRANTS. Every reference to SHARE_LINK_PUBLIC_ACCESS /
 *    SHARE_LINK_VERIFY_ACCESS outside their definition is `<BYPASS_GRANT>.<name>`
 *    — the receiver resolved to the import of BYPASS_GRANT from
 *    @/lib/tenant-rls-grants, aliases included — passed as the grant (third)
 *    argument of a withBypassRls call resolved to its import from
 *    @/lib/tenant-rls; and the top-level function enclosing that call contains,
 *    at any depth, a call of isShareCreatorAdmitted resolved to its import. Any
 *    other reference (a variable, a destructuring, a string) fails: the gate
 *    refuses what it cannot follow.
 *
 * 3. RAW FORMS. A file that references a serve grant issues raw SQL only as a
 *    tagged template: a call of $executeRaw / $queryRaw (or their Unsafe forms)
 *    with an argument list fails — by property or by string/template element
 *    access — since rule 1 reads literal text only.
 *
 * Bindings are resolved through the file's own symbols (scope-aware, no
 * Program), so a shadowing local of the same name does not count.
 *
 * KNOWN LIMITS: ordering (the pre-check before the password-protected branch or
 * the password check) is pinned by the integration cells, not here; a call whose
 * result is discarded still counts; an ORM write of view_count
 * (passwordShare.update with viewCount) is not recognised as a serving statement
 * — no serve path uses one, and the integration cells A12 pin the UPDATEs; rule 3
 * does not follow an aliased raw method (`const run = tx.$executeRawUnsafe`) or
 * an untagged raw call in a helper module the serving file imports (moving an
 * existing statement there drops the pinned count; a new one is not seen).
 *
 * Exit 0 = clean. Exit 1 = a violation, a missing target, or site counts that
 * differ from the pinned ones.
 */
import { Node, SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SHARE_SERVE_ADMISSION_ROOT ?? join(__dirname, "..", "..");
const TARGETS = (process.env.SHARE_SERVE_ADMISSION_TARGETS ?? "src").split(",");

const GRANT_DEFINITION = "src/lib/tenant-rls-grants.ts";
const SERVE_GRANTS = new Set(["SHARE_LINK_PUBLIC_ACCESS", "SHARE_LINK_VERIFY_ACCESS"]);
const IMPORTS = {
  withBypassRls: "@/lib/tenant-rls",
  BYPASS_GRANT: "@/lib/tenant-rls-grants",
  isShareCreatorAdmitted: "@/lib/share/share-admission",
};

/** Pinned site counts of the real tree. A change is a site to review. */
const EXPECTED = {
  statements: Number(process.env.SHARE_SERVE_ADMISSION_STATEMENTS ?? 6),
  grantReferences: Number(process.env.SHARE_SERVE_ADMISSION_GRANT_REFS ?? 5),
};

console.log(`check-share-serve-admission: ROOT=${REPO_ROOT}`);

const unresolved = unresolvedTargets(TARGETS, REPO_ROOT);
if (unresolved.length > 0) {
  console.error(`\nFAIL: scan target not found under ${REPO_ROOT}: ${unresolved.join(", ")}`);
  process.exit(1);
}

/** Whether `id` is bound to the named import of `exported` from `module` in its file. */
function resolvesToImport(id, exported, module) {
  if (!Node.isIdentifier(id)) return false;
  const declarations = id.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((d) => {
    if (!Node.isImportSpecifier(d)) return false;
    if (d.getName() !== exported) return false;
    return d.getImportDeclaration().getModuleSpecifierValue() === module;
  });
}

function calleeIs(call, exported) {
  return resolvesToImport(call.getExpression(), exported, IMPORTS[exported]);
}

/** The outermost function-like node enclosing `node` (the module-level function). */
function topLevelFunction(node) {
  let top;
  for (let a = node.getParent(); a; a = a.getParent()) {
    if (
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a)
    ) {
      top = a;
    }
  }
  return top;
}

function literalText(template) {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralText();
  if (Node.isTemplateExpression(template)) {
    return [
      template.getHead().getLiteralText(),
      ...template.getTemplateSpans().map((s) => s.getLiteral().getLiteralText()),
    ].join(" ");
  }
  return "";
}

const project = createAstProject();
const violations = [];
let statements = 0;
let grantReferences = 0;

for (const { rel, sf } of sourceFilesFrom(project, TARGETS, REPO_ROOT)) {

  // 1. Serving statements carry the admission call.
  for (const tagged of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    const tag = tagged.getTag();
    const tagName = Node.isPropertyAccessExpression(tag) ? tag.getName() : Node.isIdentifier(tag) ? tag.getText() : "";
    if (tagName !== "$executeRaw" && tagName !== "$queryRaw") continue;
    const text = literalText(tagged.getTemplate());
    if (!/\bpassword_shares\b/i.test(text) || !/\bview_count\b/i.test(text)) continue;
    statements++;
    if (!text.includes("share_creator_admitted(")) {
      violations.push(`${rel}:${tagged.getStartLineNumber()}: password_shares view_count statement without share_creator_admitted(...)`);
    }
  }

  // 2. Serve grants: used only by a withBypassRls call whose function pre-checks admission.
  if (rel === GRANT_DEFINITION) continue;
  const mentions = [
    ...sf.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => SERVE_GRANTS.has(id.getText())),
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral).filter((s) => SERVE_GRANTS.has(s.getLiteralText())),
    ...sf
      .getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      .filter((s) => SERVE_GRANTS.has(s.getLiteralText())),
  ];
  // 3. A serving file issues raw SQL only through tagged templates rule 1 can read.
  if (mentions.length > 0) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      let name = "";
      if (Node.isPropertyAccessExpression(callee)) name = callee.getName();
      else if (Node.isElementAccessExpression(callee)) {
        const key = callee.getArgumentExpression();
        if (key && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key))) name = key.getLiteralText();
      }
      if (/^\$(executeRaw|queryRaw)(Unsafe)?$/.test(name)) {
        violations.push(`${rel}:${call.getStartLineNumber()}: ${name}(...) called with arguments in a serving file — use a tagged template`);
      }
    }
  }
  for (const mention of mentions) {
    grantReferences++;
    const where = `${rel}:${mention.getStartLineNumber()}`;
    const access = mention.getParent();
    if (
      !Node.isIdentifier(mention) ||
      !Node.isPropertyAccessExpression(access) ||
      access.getNameNode() !== mention ||
      !resolvesToImport(access.getExpression(), "BYPASS_GRANT", IMPORTS.BYPASS_GRANT)
    ) {
      violations.push(`${where}: ${mention.getText()} is not read as BYPASS_GRANT.<grant> (the gate cannot follow it)`);
      continue;
    }
    const call = access.getParent();
    if (!Node.isCallExpression(call) || call.getArguments()[2] !== access || !calleeIs(call, "withBypassRls")) {
      violations.push(`${where}: ${access.getText()} is not the grant argument of a withBypassRls call`);
      continue;
    }
    const fn = topLevelFunction(call);
    const admits =
      fn !== undefined &&
      fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => calleeIs(c, "isShareCreatorAdmitted"));
    if (!admits) {
      violations.push(`${where}: the function serving under ${access.getName()} never calls isShareCreatorAdmitted`);
    }
  }
}

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error(`\nFAIL: ${violations.length} share serve path(s) without creator admission:`);
  for (const v of violations) console.error(`  ${v}`);
}
const counts = { statements, grantReferences };
for (const [key, want] of Object.entries(EXPECTED)) {
  if (counts[key] !== want) {
    failed = true;
    console.error(`\nFAIL: ${key} = ${counts[key]}, expected ${want} — a serve site was added or lost; review it and update EXPECTED`);
  }
}
if (failed) process.exit(1);
console.log(`check-share-serve-admission: OK (${statements} statements, ${grantReferences} grant references)`);
