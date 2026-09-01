#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): a request IP written to a length-bounded column must
 * be sliced to that column's width at the write site.
 *
 * THE CLASS, AND WHY IT NEEDS A GATE. `extractClientIp` performs no length or
 * format validation: `normalizeIp` trims, unwraps brackets, and otherwise
 * returns its input, and `extractClientIpFromHeaders` returns whichever
 * `X-Forwarded-For` segment the walk lands on. Behind a trusted proxy that value
 * is client-controlled, so an arbitrarily long token reaches whatever column the
 * write targets. Three columns store one: `audit_logs.ip`,
 * `share_access_logs.ip` and `sessions.ip_address`, all `@db.VarChar(45)`.
 *
 * One member needs no attacker at all. The retention sweep copies
 * `extension_tokens.last_used_ip` — `@db.VarChar(64)` — into `audit_logs.ip`, so
 * nineteen characters of over-run are structural.
 *
 * The failure is quiet in every direction, and differently quiet per member:
 * `22001` (unlike `22P02`) does not echo the offending value, so there is no
 * value in the error to recognise it by. In the outbox worker the row cycles to
 * max_attempts and the audit event is lost; at the two share-access writers the
 * insert is `.catch()`-ed and the access-log row is dropped; in the session
 * writers it aborts session creation; on the Break Glass path the enclosing
 * catch returns 503 and denies an incident-response view.
 *
 * WHY THIS EXISTS RATHER THAN A REVIEW HABIT. The audit emitter was fixed on its
 * own first, and the fix read as complete: it repaired the site the defect was
 * found at. Seven other writers had the same shape, and two independent reviews
 * of that fix each enumerated a DIFFERENT, incomplete subset of them — one
 * missed the share-link page, the other missed four. A hand-list is what fails
 * here; the member set has to be derived from the write, every run.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a bounded scan root.
 * NOT an enforceable boundary — bypassable by editing the gate, by building the
 * payload object in a shape it does not model (see MISSED), or by writing
 * outside SEARCH_DIRS. The column itself is the boundary; it rejects. This gate
 * exists because rejecting is the failure we are trying not to have.
 *
 *   CAUGHT   an `ip` / `ipAddress` property, holding anything other than a
 *            slice or a null-ish literal, in (a) the `data` of a Prisma
 *            create/update/upsert on `auditLog`, `shareAccessLog` or `session`,
 *            (b) an object literal returned from a function annotated
 *            `: AuditOutboxPayload`, or (c) an object-literal argument to an
 *            `enqueueAudit*` call.
 *   PASSES   `ip: null`; a slice to an identifier ending `_IP_MAX_LENGTH`;
 *            and a property whose value is a call to something already bounded,
 *            provided the slice is inside it.
 *   MISSED   a payload assembled in another file and passed by variable — (b)
 *            and (c) exist to cover the two such producers this tree actually
 *            has, but a third would need the call graph this gate runs without;
 *            a `data` object spread from a helper; and any write reaching these
 *            columns through raw SQL, which no AST shape here models.
 *
 * Runs without a Program (in-memory project), like its two sibling gates.
 */
import { Project, ts } from "ts-morph";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const { SyntaxKind } = ts;

const REPO_ROOT = process.env.IP_COLUMN_BOUNDS_ROOT
  ? resolve(process.env.IP_COLUMN_BOUNDS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Env pollution guard, mirroring the sibling gates: the override exists for the
// self-test, and left ungated it is a way to point CI's check at a fixture tree
// that trivially satisfies it.
if (
  process.env.CI === "true" &&
  process.env.IP_COLUMN_BOUNDS_ROOT &&
  process.env.IP_COLUMN_BOUNDS_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-ip-column-bounds: IP_COLUMN_BOUNDS_ROOT must not be set in CI (it " +
      "would point the check at a tree that is not the one shipping). Set " +
      "IP_COLUMN_BOUNDS_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

const SEARCH_DIRS = (process.env.IP_COLUMN_BOUNDS_DIRS ?? "src")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

/** Prisma models whose row carries a request IP in a bounded column. */
const BOUNDED_MODELS = new Set(["auditLog", "shareAccessLog", "session"]);
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const PAYLOAD_TYPE = "AuditOutboxPayload";
const ENQUEUE_RE = /^enqueueAudit/;
const IP_PROPS = new Set(["ip", "ipAddress"]);
const BOUND_RE = /_IP_MAX_LENGTH$/;

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

/** The object literal a Prisma write's `data:` names, if this call is one. */
function prismaWriteDataObject(call) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  if (!WRITE_METHODS.has(callee.getName())) return null;
  const receiver = callee.getExpression();
  if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  if (!BOUNDED_MODELS.has(receiver.getName())) return null;

  const arg = call.getArguments()[0];
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const dataProp = arg.getProperty("data");
  if (!dataProp || dataProp.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = dataProp.getInitializer();
  return init && init.getKind() === SyntaxKind.ObjectLiteralExpression ? init : null;
}

/** Object-literal arguments to an `enqueueAudit*` call. */
function enqueueArgObjects(call) {
  const callee = call.getExpression();
  const name =
    callee.getKind() === SyntaxKind.Identifier
      ? callee.getText()
      : callee.getKind() === SyntaxKind.PropertyAccessExpression
        ? callee.getName()
        : null;
  if (!name || !ENQUEUE_RE.test(name)) return [];
  return call.getArguments().filter((a) => a.getKind() === SyntaxKind.ObjectLiteralExpression);
}

/** Object literals returned from a function annotated `: AuditOutboxPayload`. */
function payloadBuilderObjects(sf) {
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
      for (const obj of fn.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        out.push(obj);
      }
    }
  }
  return out;
}

/**
 * Bounded when the value slices to a named column-width constant, or is a
 * null-ish literal. `.slice(0, 45)` with a bare number is NOT accepted: the
 * number is the thing that has to stay tied to the schema, and a literal is how
 * it stops being.
 */
function isBounded(valueNode) {
  const kind = valueNode.getKind();
  if (kind === SyntaxKind.NullKeyword) return true;
  if (kind === SyntaxKind.Identifier && valueNode.getText() === "undefined") return true;

  for (const call of valueNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (callee.getName() !== "slice") continue;
    const bound = call.getArguments()[1];
    if (bound && BOUND_RE.test(bound.getText())) return true;
  }
  return false;
}

const violations = [];
let writeSites = 0;
let ipProps = 0;

for (const sf of project.getSourceFiles()) {
  const objects = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const data = prismaWriteDataObject(call);
    if (data) objects.push(data);
    objects.push(...enqueueArgObjects(call));
  }
  objects.push(...payloadBuilderObjects(sf));
  if (objects.length === 0) continue;
  writeSites += objects.length;

  for (const obj of objects) {
    for (const prop of obj.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const name = prop.getName().replace(/^["']|["']$/g, "");
      if (!IP_PROPS.has(name)) continue;
      const init = prop.getInitializer();
      if (!init) continue;
      ipProps++;
      if (isBounded(init)) continue;
      violations.push({
        file: sf.getFilePath().replace(`${REPO_ROOT}/`, ""),
        line: prop.getStartLineNumber(),
        prop: name,
        text: init.getText().replace(/\s+/g, " ").slice(0, 90),
      });
    }
  }
}

// Fail-loud floors. Each is a separate way for the scan to have examined
// nothing while still printing OK, and a summed floor cannot tell them apart.
if (writeSites === 0) {
  fail(
    `recognised 0 write sites across ${files.length} files — the Prisma model names, ` +
      `the payload type or the enqueue prefix moved, and this run proves nothing`,
  );
}
if (ipProps === 0) {
  fail(
    `recognised ${writeSites} write site(s) but 0 ip properties — the column's field ` +
      `name changed, so the gate is watching a shape that no longer carries an IP`,
  );
}

if (violations.length > 0) {
  console.error(
    `check-ip-column-bounds: ${violations.length} unbounded IP write(s) reaching a VarChar(45) column:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.prop}: ${v.text}`);
  }
  console.error(
    `\nSlice to the constant that matches the DESTINATION column — AUDIT_IP_MAX_LENGTH,\n` +
      `SHARE_ACCESS_IP_MAX_LENGTH or SESSION_IP_MAX_LENGTH in\n` +
      `src/lib/validations/common.server.ts. Not a bare number, and not whichever\n` +
      `constant is already imported: they are equal today and are three separate\n` +
      `schema decisions.\n\n` +
      `extractClientIp does not validate length, so the value is caller-controlled\n` +
      `behind a trusted proxy. An over-length write raises 22001, which does not echo\n` +
      `the value — the record is lost with nothing in the error to recognise it by.`,
  );
  process.exit(1);
}

console.log(
  `check-ip-column-bounds: scanned ${files.length} files, ${writeSites} write site(s), ${ipProps} ip propert(ies)`,
);
console.log("check-ip-column-bounds: OK");
