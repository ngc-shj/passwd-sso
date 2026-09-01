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
 *   MISSED   a payload assembled in another file and passed by variable — (b)
 *            and (c) cover the two such producers this tree has, but a third
 *            would need the call graph this gate runs without; a `data` object
 *            spread from a helper; a value pre-sliced into a local and then
 *            passed by name (deliberately CAUGHT rather than missed, see above);
 *            the POSITIONAL-ARGUMENT shape, where an object is built under one
 *            name and passed to a callee whose parameter is the sink; and any
 *            write reaching these columns through raw SQL.
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

function objectLiteralsOf(node) {
  if (!node) return [];
  if (node.getKind() === SyntaxKind.ObjectLiteralExpression) return [node];
  if (node.getKind() === SyntaxKind.ArrayLiteralExpression) {
    return node.getElements().filter((e) => e.getKind() === SyntaxKind.ObjectLiteralExpression);
  }
  return [];
}

/** Object literals a Prisma write on a bounded model puts row data in. */
function prismaWriteTargets(call) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const method = callee.getName();
  if (!WRITE_METHODS.has(method)) return null;
  const receiver = callee.getExpression();
  if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const model = receiver.getName();
  if (!Object.hasOwn(BOUNDED_COLUMNS, model)) return null;

  const arg = call.getArguments()[0];
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;

  // `upsert` carries create:/update:, not data:. `createMany`'s data is an
  // array. Both were listed in WRITE_METHODS by the first version and
  // unreachable, which is a declared coverage the gate could not deliver.
  const keys = method === "upsert" ? ["create", "update"] : ["data"];
  const objects = [];
  for (const key of keys) {
    const prop = arg.getProperty(key);
    if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    objects.push(...objectLiteralsOf(prop.getInitializer()));
  }
  return { model, columns: BOUNDED_COLUMNS[model], objects };
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
  const objects = call
    .getArguments()
    .filter((a) => a.getKind() === SyntaxKind.ObjectLiteralExpression);
  return objects.length > 0 ? { model: "payload", columns: PAYLOAD_COLUMNS, objects } : null;
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
      const objects = fn.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
      if (objects.length > 0) out.push({ model: "payload", columns: PAYLOAD_COLUMNS, objects });
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
function isBounded(node, expected) {
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
  if (kind === SyntaxKind.ParenthesizedExpression) return isBounded(node.getExpression(), expected);
  if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.NonNullExpression) {
    return isBounded(node.getExpression(), expected);
  }
  if (kind === SyntaxKind.ConditionalExpression) {
    return isBounded(node.getWhenTrue(), expected) && isBounded(node.getWhenFalse(), expected);
  }
  if (kind === SyntaxKind.BinaryExpression) {
    const op = node.getOperatorToken().getKind();
    // `x?.slice(0, C) ?? null` passes; `x ?? y.slice(0, C)` does not — every arm
    // is a value this property can take.
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      return isBounded(node.getLeft(), expected) && isBounded(node.getRight(), expected);
    }
    return false;
  }
  if (kind !== SyntaxKind.CallExpression) return false;
  const callee = node.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  if (callee.getName() !== "slice") return false;
  const bound = node.getArguments()[1];
  // By NAME, not by shape: a bare `.slice(0, 45)` bounds the value and cuts the
  // tie to the schema, and a sibling column's constant bounds it to a width that
  // is only equal today.
  return Boolean(bound) && bound.getText() === expected;
}

const violations = [];
const seen = Object.fromEntries(MEMBERS.map((m) => [m, 0]));
let writeSites = 0;

for (const sf of project.getSourceFiles()) {
  const targets = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const prisma = prismaWriteTargets(call);
    if (prisma) targets.push(prisma);
    const enqueue = enqueueTargets(call);
    if (enqueue) targets.push(enqueue);
  }
  targets.push(...payloadBuilderTargets(sf));
  if (targets.length === 0) continue;

  for (const { model, columns, objects } of targets) {
    writeSites += objects.length;
    for (const obj of objects) {
      for (const prop of obj.getProperties()) {
        const kind = prop.getKind();
        const isShorthand = kind === SyntaxKind.ShorthandPropertyAssignment;
        if (kind !== SyntaxKind.PropertyAssignment && !isShorthand) continue;
        const name = prop.getName().replace(/^["']|["']$/g, "");
        const expected = columns[name];
        if (!expected) continue;
        seen[`${model}.${name}`] += 1;

        // Shorthand carries no expression to inspect, so it can never be shown
        // bounded here. Reported rather than skipped: skipping would make
        // `{ ipAddress }` the one spelling the gate cannot see.
        const value = isShorthand ? null : prop.getInitializer();
        if (value && isBounded(value, expected)) continue;
        violations.push({
          file: sf.getFilePath().replace(`${REPO_ROOT}/`, ""),
          line: prop.getStartLineNumber(),
          member: `${model}.${name}`,
          expected,
          text: isShorthand
            ? `${name} (shorthand)`
            : (value?.getText() ?? "").replace(/\s+/g, " ").slice(0, 90),
        });
      }
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
