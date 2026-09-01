#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): a request-derived value written to a length-bounded
 * column must be sliced to THAT column's width, using THAT column's constant.
 *
 * THE CLASS, AND WHY IT NEEDS A GATE. `extractClientIp` performs no length or
 * format validation: `normalizeIp` trims, unwraps brackets, and otherwise
 * returns its input, and `extractClientIpFromHeaders` returns whichever
 * `X-Forwarded-For` segment the walk lands on. Behind a trusted proxy that value
 * is client-controlled, so an arbitrarily long token reaches whatever column the
 * write targets. `user-agent` is the same shape with no validation at all.
 *
 * One member needs no attacker. The retention sweep copies
 * `extension_tokens.last_used_ip` — `VarChar(64)` — into `audit_logs.ip`, which
 * is `VarChar(45)`, so nineteen characters of over-run are structural.
 *
 * The failure is quiet in every direction, and differently quiet per member:
 * `22001` (unlike `22P02`) does not echo the offending value, so there is no
 * value in the error to recognise it by. In the outbox worker the row cycles to
 * max_attempts and the audit event is lost; at the share-access writers the
 * insert is `.catch()`-ed and the access-log row is dropped; in the session and
 * bridge-code writers it aborts sign-in outright; the `lastUsedIp` updates are
 * fire-and-forget, so an over-run silently drops forensic provenance.
 *
 * WHY THIS EXISTS RATHER THAN A REVIEW HABIT — and why the member set is read
 * from the schema. A hand-list has now failed at this exact class four times:
 * the audit emitter was fixed alone and read as complete; two independent
 * reviews of that fix each enumerated a DIFFERENT incomplete subset; a
 * re-derivation over the columns found eight sites and the first version of this
 * gate found a ninth; and that version's own member set silently collapsed
 * "length-bounded column" to "VarChar(45)", missing three `VarChar(64)` columns
 * and two `VarChar(512)` ones. BOUNDED_COLUMNS below is therefore a transcript
 * of the schema, and `scripts/__tests__/check-ip-column-bounds.test.mjs` pins
 * every member with its own case.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a bounded scan root.
 * NOT an enforceable boundary — bypassable by editing the gate, by building the
 * payload object in a shape it does not model (see MISSED), or by writing
 * outside SEARCH_DIRS. The column itself is the boundary; it rejects. This gate
 * exists because rejecting is the failure we are trying not to have.
 *
 *   CAUGHT   a watched property, holding anything but a slice to its OWN
 *            column's constant or a null-ish literal, in (a) the `data` of a
 *            Prisma create/update/upsert/createMany on a BOUNDED_COLUMNS model
 *            — including `upsert`'s `create:`/`update:` and `createMany`'s array
 *            elements, (b) an object literal returned from a function annotated
 *            `: AuditOutboxPayload`, or (c) an object-literal argument to an
 *            `enqueueAudit*` call. Shorthand (`{ ipAddress }`) is CAUGHT: the
 *            gate cannot see where the binding came from, and the fix — slice at
 *            the property — is the same one every other site uses.
 *   PASSES   `null` / `undefined`; a slice whose bound is the destination
 *            column's own constant; and a conditional or `??`/`||` chain whose
 *            every arm independently passes. Arms are checked structurally, not
 *            by descendant search, so a ternary with ONE bounded arm does not.
 *   REFUSED  a write on a bounded model whose row data cannot be READ — a `data:`
 *            that is neither an object literal, an array of them, nor a local
 *            binding this file can resolve. Refused, not skipped, and separately
 *            from a violation: "I looked and it was wrong" and "I could not look"
 *            need different repairs. Skipping was the first version's behaviour
 *            and it hid `validate-token-dpop.ts`'s `data: updateData`, whose
 *            slice could be reverted with the gate still printing OK.
 *   MISSED   a payload assembled in ANOTHER file and passed by variable — (b) and
 *            (c) cover the two such producers this tree has, but a third would
 *            need the call graph this gate runs without; a `data` object spread
 *            from a helper; the POSITIONAL-ARGUMENT shape, where an object is
 *            built under one name and passed to a callee whose parameter is the
 *            sink; a computed key (`{ ["ipAddress"]: raw }`); an emit through a
 *            function-valued parameter, which `ENQUEUE_RE` cannot name; and any
 *            write reaching these columns through raw SQL.
 *
 * BINDING RESOLUTION is file-scoped and blunt in the refusing direction. The
 * slice's bound must be spelled as the destination's constant AND that name must
 * be imported from the constants module — spelling alone accepts a same-named
 * local, which would make the per-column constants decorative. A file that also
 * DECLARES that name loses the import, without regard to scope: deciding which
 * binding an identifier refers to needs a type checker this gate runs without,
 * so the imprecision is spent on refusing rather than on passing.
 *
 * Runs without a Program (in-memory project), like its two sibling gates.
 */
import { Project, ts } from "ts-morph";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const { SyntaxKind } = ts;

const ROOT_OVERRIDE = process.env.IP_COLUMN_BOUNDS_ROOT;
const DIRS_OVERRIDE = process.env.IP_COLUMN_BOUNDS_DIRS;

const REPO_ROOT = ROOT_OVERRIDE
  ? resolve(ROOT_OVERRIDE)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Env pollution guard. BOTH overrides are in the predicate, not just the root:
 * `IP_COLUMN_BOUNDS_DIRS` narrows the scan independently, and narrowing is the
 * same attack as redirecting — pointing CI at 14 of 1037 files satisfies every
 * floor below and prints OK. The sibling gate computes the same disjunction and
 * names DIRS-narrowing as the threat; the first version of this file copied only
 * the root half.
 */
const HAS_OVERRIDE = Boolean(ROOT_OVERRIDE) || Boolean(DIRS_OVERRIDE);
if (
  process.env.CI === "true" &&
  HAS_OVERRIDE &&
  process.env.IP_COLUMN_BOUNDS_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-ip-column-bounds: IP_COLUMN_BOUNDS_ROOT / IP_COLUMN_BOUNDS_DIRS must " +
      "not be set in CI (either one points the check at a tree, or a slice of one, " +
      "that is not what ships). Set IP_COLUMN_BOUNDS_FIXTURE_MODE=1 only from the " +
      "self-test.",
  );
  process.exit(1);
}

// `scripts` as well as `src`, matching the sibling gate: scripts/ holds an audit
// emitter, so excluding it would be a scan-root gap rather than a scope decision.
const SEARCH_DIRS = (DIRS_OVERRIDE ?? "src,scripts")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

/**
 * A transcript of every length-bounded column in `prisma/schema.prisma` that
 * holds a request-derived string, keyed by the Prisma model that writes it.
 *
 * Each property names its OWN constant. They are not interchangeable even where
 * the numbers are equal: the whole reason `common.server.ts` declares one per
 * column is that a future widening of a single column must not silently license
 * the old width at the other write paths. The gate compares by name for that
 * reason — accepting any `*_MAX_LENGTH` would make the constants decorative.
 *
 * ONE RECORDED EXCEPTION. `auditLog`, `shareAccessLog` and `session` share
 * `USER_AGENT_MAX_LENGTH` rather than each having its own. That is a stop, not
 * the rule: the constant predates this gate and has eight consumers, so splitting
 * it is a separate change. The cost is exactly the one the rule describes —
 * widening `audit_logs.user_agent` alone would license the old width at the other
 * two — and it is why the sibling-constant deny case can only be written for
 * `ip`. The five per-column constants added with this gate do follow the rule.
 */
const BOUNDED_COLUMNS = {
  auditLog: { ip: "AUDIT_IP_MAX_LENGTH", userAgent: "USER_AGENT_MAX_LENGTH" },
  shareAccessLog: { ip: "SHARE_ACCESS_IP_MAX_LENGTH", userAgent: "USER_AGENT_MAX_LENGTH" },
  session: { ipAddress: "SESSION_IP_MAX_LENGTH", userAgent: "USER_AGENT_MAX_LENGTH" },
  extensionBridgeCode: {
    ip: "EXTENSION_BRIDGE_CODE_IP_MAX_LENGTH",
    userAgent: "EXTENSION_BRIDGE_CODE_USER_AGENT_MAX_LENGTH",
  },
  mobileBridgeCode: {
    ip: "MOBILE_BRIDGE_CODE_IP_MAX_LENGTH",
    userAgent: "MOBILE_BRIDGE_CODE_USER_AGENT_MAX_LENGTH",
  },
  // last_used_user_agent is @db.Text — unbounded, so deliberately not a member.
  extensionToken: { lastUsedIp: "EXTENSION_TOKEN_LAST_USED_IP_MAX_LENGTH" },
};

/** Shapes (b) and (c) both build the audit outbox payload. */
const PAYLOAD_COLUMNS = { ip: "AUDIT_IP_MAX_LENGTH", userAgent: "USER_AGENT_MAX_LENGTH" };

const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const PAYLOAD_TYPE = "AuditOutboxPayload";
const ENQUEUE_RE = /^enqueueAudit/;

/** Every member that must be SEEN at least once, or the scan proves nothing. */
const MEMBERS = [
  ...Object.entries(BOUNDED_COLUMNS).flatMap(([model, props]) =>
    Object.keys(props).map((p) => `${model}.${p}`),
  ),
  ...Object.keys(PAYLOAD_COLUMNS).map((p) => `payload.${p}`),
];

function fail(msg) {
  console.error(`check-ip-column-bounds: ${msg}`);
  process.exit(1);
}

function collectFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
      continue;
    }
    const ext = extname(full);
    if (ext !== ".ts" && ext !== ".tsx") continue;
    if (/\.(test|spec)\.tsx?$/.test(full)) continue;
    out.push(full);
  }
}

const files = [];
for (const dir of SEARCH_DIRS) collectFiles(join(REPO_ROOT, dir), files);
if (files.length === 0) {
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — the scan root or the ` +
      `directory list is wrong, and a run that examined nothing must not print OK`,
  );
}

const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
for (const f of files) project.addSourceFileAtPath(f);

const CONSTANTS_MODULE_RE = /validations\/common\.server$/;

/**
 * The constant names this file IMPORTS from the constants module.
 *
 * Comparing the slice bound by spelling alone accepts a same-named binding from
 * anywhere — including `const SESSION_IP_MAX_LENGTH = 100000` declared three
 * lines up. That defeats the reason the constants are per-column at all: the
 * name would be doing the work the schema tie is supposed to do. The bound must
 * therefore both READ as the destination's constant and RESOLVE to the module
 * that owns it.
 */
function importedConstants(sf) {
  const names = new Set();
  for (const imp of sf.getImportDeclarations()) {
    if (!CONSTANTS_MODULE_RE.test(imp.getModuleSpecifierValue())) continue;
    for (const named of imp.getNamedImports()) names.add(named.getName());
  }
  // A local declaration of the same name disqualifies the import, file-wide and
  // without regard to scope. That is deliberately blunt: resolving which binding
  // an identifier refers to needs a type checker this gate runs without, and the
  // blunt reading errs toward REFUSING — a file that both imports a constant and
  // declares something with its name gets a violation it can fix by renaming,
  // rather than a pass it cannot see through.
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    names.delete(decl.getName());
  }
  return names;
}

/** One watched property, from an object literal or from a later assignment. */
function entriesOf(obj) {
  const out = [];
  for (const prop of obj.getProperties()) {
    const kind = prop.getKind();
    if (kind === SyntaxKind.PropertyAssignment) {
      out.push({
        name: prop.getName().replace(/^["']|["']$/g, ""),
        value: prop.getInitializer(),
        line: prop.getStartLineNumber(),
      });
    } else if (kind === SyntaxKind.ShorthandPropertyAssignment) {
      out.push({ name: prop.getName(), value: null, line: prop.getStartLineNumber() });
    }
  }
  return out;
}

/**
 * The watched properties a `data:` / `create:` / `update:` initializer carries.
 *
 * `data: updateData` — an object built under a name and handed over — is a real
 * shape in this tree, and the first version of this gate skipped it. Skipping is
 * the worst of the three options: `validate-token-dpop.ts` writes
 * `extension_tokens.last_used_ip` exactly that way, and reverting its slice left
 * the gate at exit 0. The per-member floor cannot cover for it either, since the
 * member is seen at three OTHER sites and the count stays non-zero.
 *
 * So a local binding is resolved — its object-literal initializer plus every
 * `name.prop = value` assignment in the same file — and anything still
 * unresolvable is REPORTED rather than skipped. Same argument the shorthand case
 * already makes: the one spelling the gate cannot see is the one that gets used.
 */
function dataEntries(node, sf) {
  if (!node) return { entries: [], unresolved: null };
  const kind = node.getKind();
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    return { entries: entriesOf(node), unresolved: null };
  }
  if (kind === SyntaxKind.ArrayLiteralExpression) {
    return {
      entries: node
        .getElements()
        .filter((e) => e.getKind() === SyntaxKind.ObjectLiteralExpression)
        .flatMap(entriesOf),
      unresolved: null,
    };
  }
  if (kind === SyntaxKind.Identifier) {
    const name = node.getText();
    const decl = sf
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((d) => d.getName() === name);
    const init = decl?.getInitializer();
    if (!decl || !init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) {
      return { entries: [], unresolved: `${name} (no local object-literal declaration)` };
    }
    const entries = entriesOf(init);
    // `updateData.lastUsedIp = …` after the declaration.
    for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      const left = bin.getLeft();
      if (left.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      if (left.getExpression().getText() !== name) continue;
      entries.push({
        name: left.getName(),
        value: bin.getRight(),
        line: bin.getStartLineNumber(),
      });
    }
    return { entries, unresolved: null };
  }
  return { entries: [], unresolved: node.getText().replace(/\s+/g, " ").slice(0, 60) };
}

/** Object literals a Prisma write on a bounded model puts row data in. */
function prismaWriteTargets(call, sf) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const method = callee.getName();
  if (!WRITE_METHODS.has(method)) return null;
  const receiver = callee.getExpression();
  if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const model = receiver.getName();
  if (!Object.hasOwn(BOUNDED_COLUMNS, model)) return null;

  const arg = call.getArguments()[0];
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    return { model, columns: BOUNDED_COLUMNS[model], entries: [], unresolved: ["<call argument>"] };
  }

  // `upsert` carries create:/update:, not data:. `createMany`'s data is an
  // array. Both were listed in WRITE_METHODS by the first version and
  // unreachable, which is a declared coverage the gate could not deliver.
  const keys = method === "upsert" ? ["create", "update"] : ["data"];
  const entries = [];
  const unresolved = [];
  for (const key of keys) {
    const prop = arg.getProperty(key);
    if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const r = dataEntries(prop.getInitializer(), sf);
    entries.push(...r.entries);
    if (r.unresolved) unresolved.push(`${key}: ${r.unresolved}`);
  }
  return { model, columns: BOUNDED_COLUMNS[model], entries, unresolved };
}

function enqueueTargets(call) {
  const callee = call.getExpression();
  const name =
    callee.getKind() === SyntaxKind.Identifier
      ? callee.getText()
      : callee.getKind() === SyntaxKind.PropertyAccessExpression
        ? callee.getName()
        : null;
  if (!name || !ENQUEUE_RE.test(name)) return null;
  const entries = call
    .getArguments()
    .filter((a) => a.getKind() === SyntaxKind.ObjectLiteralExpression)
    .flatMap(entriesOf);
  return entries.length > 0
    ? { model: "payload", columns: PAYLOAD_COLUMNS, entries, unresolved: [] }
    : null;
}

function payloadBuilderTargets(sf) {
  const out = [];
  for (const kind of [
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
  ]) {
    for (const fn of sf.getDescendantsOfKind(kind)) {
      const ret = fn.getReturnTypeNode();
      if (!ret || !ret.getText().includes(PAYLOAD_TYPE)) continue;
      const entries = fn
        .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
        .flatMap(entriesOf);
      if (entries.length > 0) {
        out.push({ model: "payload", columns: PAYLOAD_COLUMNS, entries, unresolved: [] });
      }
    }
  }
  return out;
}

/**
 * Structural, not a descendant search.
 *
 * `getDescendantsOfKind(CallExpression)` over the whole value was the first
 * version's test, and it accepts a ternary with ONE bounded arm — the slice is
 * somewhere underneath, so the value "contains a slice" while one path through
 * it does not. Each arm is therefore checked on its own, and a bare expression
 * has to BE the slice rather than merely contain one.
 */
function isBounded(node, expected, imported) {
  const kind = node.getKind();
  if (kind === SyntaxKind.NullKeyword) return true;
  if (kind === SyntaxKind.Identifier && node.getText() === "undefined") return true;
  // An authored literal is not in this class — the class is "a request-derived
  // value", and a constant written in the source is neither caller-controlled
  // nor able to change at runtime. If one ever exceeds its column, that is an
  // authoring error the first insert reports, not a silent over-run.
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return true;
  }
  if (kind === SyntaxKind.ParenthesizedExpression) return isBounded(node.getExpression(), expected, imported);
  if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.NonNullExpression) {
    return isBounded(node.getExpression(), expected, imported);
  }
  if (kind === SyntaxKind.ConditionalExpression) {
    return isBounded(node.getWhenTrue(), expected, imported) && isBounded(node.getWhenFalse(), expected, imported);
  }
  if (kind === SyntaxKind.BinaryExpression) {
    const op = node.getOperatorToken().getKind();
    // `x?.slice(0, C) ?? null` passes; `x ?? y.slice(0, C)` does not — every arm
    // is a value this property can take.
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      return isBounded(node.getLeft(), expected, imported) && isBounded(node.getRight(), expected, imported);
    }
    return false;
  }
  if (kind !== SyntaxKind.CallExpression) return false;
  const callee = node.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  if (callee.getName() !== "slice") return false;
  const bound = node.getArguments()[1];
  if (!bound || bound.getText() !== expected) return false;
  // The name is necessary and NOT sufficient. A bare `.slice(0, 45)` cuts the
  // tie to the schema and a sibling column's constant bounds to a width that is
  // only equal today — both are caught by the spelling test above. What the
  // spelling alone still admits is a same-named binding from anywhere, including
  // `const SESSION_IP_MAX_LENGTH = 100000` three lines up, which would make the
  // per-column constants decorative in exactly the way this gate exists to stop.
  // So the identifier must also resolve to an import of the module that owns it.
  return imported.has(expected);
}

const violations = [];
const unresolvedSites = [];
const seen = Object.fromEntries(MEMBERS.map((m) => [m, 0]));
let writeSites = 0;

for (const sf of project.getSourceFiles()) {
  const targets = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const prisma = prismaWriteTargets(call, sf);
    if (prisma) targets.push(prisma);
    const enqueue = enqueueTargets(call);
    if (enqueue) targets.push(enqueue);
  }
  targets.push(...payloadBuilderTargets(sf));
  if (targets.length === 0) continue;

  const file = sf.getFilePath().replace(`${REPO_ROOT}/`, "");
  const imported = importedConstants(sf);

  for (const { model, columns, entries, unresolved } of targets) {
    writeSites += 1;
    for (const u of unresolved ?? []) {
      unresolvedSites.push(`${file}  ${model} ← ${u}`);
    }
    for (const entry of entries) {
      const expected = columns[entry.name];
      if (!expected) continue;
      seen[`${model}.${entry.name}`] += 1;

      // A shorthand entry carries no expression, so it can never be shown
      // bounded. Reported rather than skipped: skipping would make
      // `{ ipAddress }` the one spelling the gate cannot see.
      if (entry.value && isBounded(entry.value, expected, imported)) continue;
      violations.push({
        file,
        line: entry.line,
        member: `${model}.${entry.name}`,
        expected,
        text: entry.value
          ? entry.value.getText().replace(/\s+/g, " ").slice(0, 90)
          : `${entry.name} (shorthand)`,
      });
    }
  }
}

// ─── Fail-loud floors, PER MEMBER ──────────────────────────────────────────
//
// A summed floor cannot see one member go to zero: the first version of this
// gate stayed at exit 0 with `shareAccessLog` removed from its model set,
// because the other members kept the total comfortably non-zero. That is the
// same defect the sibling narrative gate was rewritten to remove, one commit
// earlier, and this file landed with the pre-fix shape.
if (writeSites === 0) {
  fail(
    `recognised 0 write sites across ${files.length} files — the Prisma model names, ` +
      `the payload type or the enqueue prefix moved, and this run proves nothing`,
  );
}
// A write on a bounded model whose row data the gate could not read at all.
// Refused rather than skipped, and separately from a violation: "I looked and
// it was wrong" and "I could not look" need different repairs, and only one of
// them is the contributor's. Skipping was the first version's behaviour and it
// hid a real site — `data: updateData` at validate-token-dpop.ts, whose slice
// could be reverted with the gate still printing OK.
if (unresolvedSites.length > 0) {
  fail(
    `could not read the row data at ${unresolvedSites.length} write site(s):\n  ` +
      `${unresolvedSites.join("\n  ")}\n` +
      `Each is a write to a length-bounded model whose data object this gate cannot ` +
      `resolve — an object built elsewhere, or a shape not modelled. Either inline the ` +
      `object at the call, or extend dataEntries() to resolve it. Do NOT leave it: a ` +
      `site the gate cannot read is a site it cannot watch.`,
  );
}

const unseen = MEMBERS.filter((m) => seen[m] === 0);
if (unseen.length > 0) {
  fail(
    `recognised ${writeSites} write site(s) but never saw ${unseen.length} member(s): ` +
      `${unseen.join(", ")}. Either the column's field name changed, or the write moved ` +
      `to a shape this gate does not model — both mean it has stopped watching that ` +
      `column, which a total across the other members cannot show.`,
  );
}

if (violations.length > 0) {
  console.error(
    `check-ip-column-bounds: ${violations.length} unbounded write(s) reaching a length-bounded column:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.member} — expected .slice(0, ${v.expected}), found: ${v.text}`);
  }
  console.error(
    `\nSlice to the constant named above — the one that matches the DESTINATION column,\n` +
      `in src/lib/validations/common.server.ts. Not a bare number, and not whichever\n` +
      `constant is already imported: several are equal today and each is a separate\n` +
      `schema decision.\n\n` +
      `extractClientIp does not validate length, so the value is caller-controlled\n` +
      `behind a trusted proxy. An over-length write raises 22001, which does not echo\n` +
      `the value — the record is lost with nothing in the error to recognise it by.`,
  );
  process.exit(1);
}

const breakdown = MEMBERS.map((m) => `${m} ${seen[m]}`).join(", ");
console.log(
  `check-ip-column-bounds: scanned ${files.length} files, ${writeSites} write site(s) (${breakdown})`,
);
console.log("check-ip-column-bounds: OK");
