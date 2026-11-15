/**
 * Unforgeable SQL text for `$queryRawUnsafe` / `$executeRawUnsafe` call sites.
 *
 * `SqlIdentifier` and `SqlFragment` are opaque: the interfaces below carry no
 * runtime shape a caller could replicate (a type-only brand is not a runtime
 * check). The actual guarantee is a module-private WeakMap — a value is
 * genuine iff it is a key in the registry that produced it. `renderSql` is
 * the only way to get text back out, and it works from that membership, not
 * from anything the value itself exposes.
 *
 * Three registries (identifier text, table text, fragment text) rather than
 * one: `trustedSql` accepts any kind as a substitution, but `renderSql` accepts
 * only a fragment — an identifier is text for a position, not a full statement
 * — and distinguishing them needs more than a single string value per object.
 * A table is its own kind because a bearer-token table may be spliced only
 * where the template's own text makes it a relation (see `sqlTable`); an
 * identifier never names one, and `joinSql` accepts neither a table nor, for
 * that reason, anything it cannot place.
 *
 * A genuine value is `Object.create(null)`, frozen, and holds no text in any
 * own property; its only members are a shared throwing function on
 * `toString` / `valueOf` / `Symbol.toPrimitive` / `toJSON`, so every ordinary
 * way of turning it into text (template literal, `+`, `String()`, a direct
 * method call, `JSON.stringify`) throws instead of silently producing
 * `[object Object]` or `{}`.
 *
 * Built-ins this module depends on are captured when it loads, so replacing
 * them afterward (`WeakMap.prototype.get`, `Object.freeze`, …) cannot change
 * its decisions. Replacement before it loads is out of reach of any check
 * here (declared residual in the raw-SQL gate).
 */

export interface SqlIdentifier {
  readonly __sqlIdentifier: true;
}

export interface SqlTable {
  readonly __sqlTable: true;
}

export interface SqlFragment {
  readonly __sqlFragment: true;
}

// Captured at load: no property lookup at call time, so a later reassignment
// of the global (`WeakMap.prototype.get = …`, `Object.freeze = …`) cannot
// change what this module already bound/captured.
const freeze = Object.freeze;
const create = Object.create;
const isSafeInteger = Number.isSafeInteger;

const identifierRegistry = new WeakMap<object, string>();
const tableRegistry = new WeakMap<object, string>();
const fragmentRegistry = new WeakMap<object, string>();
const identifierGet = WeakMap.prototype.get.bind(identifierRegistry) as (
  key: unknown,
) => string | undefined;
const identifierSet = WeakMap.prototype.set.bind(identifierRegistry) as (
  key: object,
  value: string,
) => unknown;
const tableGet = WeakMap.prototype.get.bind(tableRegistry) as (
  key: unknown,
) => string | undefined;
const tableSet = WeakMap.prototype.set.bind(tableRegistry) as (
  key: object,
  value: string,
) => unknown;
const fragmentGet = WeakMap.prototype.get.bind(fragmentRegistry) as (
  key: unknown,
) => string | undefined;
const fragmentSet = WeakMap.prototype.set.bind(fragmentRegistry) as (
  key: object,
  value: string,
) => unknown;

function throwOnConversion(): never {
  throw new TypeError(
    "SqlIdentifier/SqlTable/SqlFragment must not be converted to a primitive, string, " +
      "or JSON value — use renderSql()",
  );
}
freeze(throwOnConversion);

/** `Object.create(null)` object whose only members throw on every conversion path. */
function createGenuineObject(): object {
  const obj = create(null) as Record<PropertyKey, unknown>;
  obj.toString = throwOnConversion;
  obj.valueOf = throwOnConversion;
  obj[Symbol.toPrimitive] = throwOnConversion;
  obj.toJSON = throwOnConversion;
  return freeze(obj);
}

// PostgreSQL 16 reserved words — `SELECT word FROM pg_get_keywords() WHERE
// catcode IN ('R','T')`, pinned by an integration test
// (src/__tests__/db-integration) against the live catalog so a server
// version bump cannot silently drift this list out of sync.
const RESERVED_SQL_WORDS: ReadonlySet<string> = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
  "asymmetric", "authorization", "binary", "both", "case", "cast", "check",
  "collate", "collation", "column", "concurrently", "constraint", "create",
  "cross", "current_catalog", "current_date", "current_role",
  "current_schema", "current_time", "current_timestamp", "current_user",
  "default", "deferrable", "desc", "distinct", "do", "else", "end", "except",
  "false", "fetch", "for", "foreign", "freeze", "from", "full", "grant",
  "group", "having", "ilike", "in", "initially", "inner", "intersect",
  "into", "is", "isnull", "join", "lateral", "leading", "left", "like",
  "limit", "localtime", "localtimestamp", "natural", "not", "notnull",
  "null", "offset", "on", "only", "or", "order", "outer", "overlaps",
  "placing", "primary", "references", "returning", "right", "select",
  "session_user", "similar", "some", "symmetric", "system_user", "table",
  "tablesample", "then", "to", "trailing", "true", "union", "unique",
  "user", "using", "variadic", "verbose", "when", "where", "window", "with",
]);

const IDENTIFIER_RE = /^[a-z_]+$/;
// Captured at load, same reasoning as the WeakMap bindings above: calling
// through these bound references means a later `RegExp.prototype.exec = …` /
// `RegExp.prototype.test = …` / `Set.prototype.has = …` cannot change what
// sqlIdentifier decides. IDENTIFIER_RE carries no `g`/`y` flag, so `.exec()`
// has no `lastIndex` state to manage across calls.
const regExec = RegExp.prototype.exec.bind(IDENTIFIER_RE) as (
  input: string,
) => RegExpExecArray | null;
const reservedHas = Set.prototype.has.bind(RESERVED_SQL_WORDS) as (
  value: string,
) => boolean;

// `@@map` names of every model declaring a digest field. Written as literals
// because the bearer passkey gate reads them from the AST and fails unless the
// set equals the schema's token tables; `sqlIdentifier` refuses them, so a
// token table can reach rendered SQL only through `sqlTable`.
export const TOKEN_TABLE_NAMES: readonly string[] = freeze([
  "extension_tokens",
  "extension_bridge_codes",
  "mobile_bridge_codes",
  "scim_tokens",
  "password_shares",
  "emergency_access_grants",
  "admin_vault_resets",
  "service_account_tokens",
  "operator_tokens",
  "api_keys",
  "mcp_authorization_codes",
  "mcp_access_tokens",
  "mcp_refresh_tokens",
]);
const tokenTableHas = Set.prototype.has.bind(new Set<string>(TOKEN_TABLE_NAMES)) as (
  value: string,
) => boolean;

function assertSqlName(caller: string, name: string): void {
  if (typeof name !== "string") {
    throw new TypeError(`${caller}: name must be a string`);
  }
  if (regExec(name) === null) {
    throw new Error(`${caller}: "${name}" must match ^[a-z_]+$`);
  }
  if (reservedHas(name)) {
    throw new Error(`${caller}: "${name}" is a reserved PostgreSQL keyword`);
  }
}

/**
 * Mint a genuine `SqlIdentifier` from a lowercase/underscore name that is not
 * a reserved PostgreSQL keyword. Precondition (enforced by review, not here):
 * `name` must be a code constant or a member of a closed literal set, not a
 * caller-supplied string — this regex bounds syntax, not intent (a data-driven
 * name can still choose the wrong table or column).
 */
export function sqlIdentifier(name: string): SqlIdentifier {
  assertSqlName("sqlIdentifier", name);
  if (tokenTableHas(name)) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.TOKEN_TABLE,
      `sqlIdentifier: "${name}" is a bearer-token table; mint it with sqlTable`,
    );
  }
  const obj = createGenuineObject();
  identifierSet(obj, name);
  return obj as unknown as SqlIdentifier;
}

/**
 * Mint a genuine `SqlTable` for any table, token tables included. Same syntax
 * and reserved-word rules (and the same precondition) as `sqlIdentifier`.
 * `trustedSql` places it only where the template's own text makes it a
 * relation, so a token table cannot be spliced into a value position
 * (`to_jsonb(${t})`) that would read its digest column without naming it.
 */
export function sqlTable(name: string): SqlTable {
  assertSqlName("sqlTable", name);
  const obj = createGenuineObject();
  tableSet(obj, name);
  return obj as unknown as SqlTable;
}

// Where a table substitution may sit, read from the template's own text. A
// relation keyword as a whole word, then whitespace and an optional opening
// quote (or the quote alone), directly before the substitution:
const TABLE_RELATION_RE = /[^A-Za-z0-9_$](?:from|join|update|into|only)(?:[ \t\r\n]+"?|")$/i;
// ... or a dot (or quote and dot) right after it, making it a qualifier.
const TABLE_QUALIFIER_RE = /^"?\./;
// A comment marker in the preceding text (any part up to the table) could supply the keyword.
const COMMENT_MARKER_RE = /--|\/\*/;
const tableRelationExec = RegExp.prototype.exec.bind(TABLE_RELATION_RE) as (
  input: string,
) => RegExpExecArray | null;
const tableQualifierExec = RegExp.prototype.exec.bind(TABLE_QUALIFIER_RE) as (
  input: string,
) => RegExpExecArray | null;
const commentMarkerExec = RegExp.prototype.exec.bind(COMMENT_MARKER_RE) as (
  input: string,
) => RegExpExecArray | null;

// A fragment is a balanced piece of SQL: a call split across two fragments (`trim(both` + `from ${t})`)
// would hand the table-position test a keyword that is really an argument. Plain character count, never
// negative scanning left to right and zero at the end; strings are not told apart (as for comment markers),
// so a parenthesis inside a string literal can fake the balance: that split stays open.
// Only trustedSql needs it: joinSql joins balanced fragments and identifiers, which stays balanced.
function assertBalanced(caller: string, text: string): void {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth < 0) break;
  }
  if (depth !== 0) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.PAREN_BALANCE,
      caller + ": assembled text must have balanced parentheses",
    );
  }
}

function assertNoCommentMarker(caller: string, text: string): void {
  if (commentMarkerExec(text) !== null) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.COMMENT_MARKER,
      caller + ": assembled text may not hold a comment marker (-- or /*)",
    );
  }
}

/**
 * Throws unless the table substitution between `strings[index]` and
 * `strings[index + 1]` sits after a relation keyword or before a dot. Only the
 * directly preceding part is read, so a table next to another substitution has
 * no keyword to lean on (an empty part matches nothing).
 */
function assertTablePosition(strings: TemplateStringsArray, index: number): void {
  const before = strings[index];
  const after = strings[index + 1];
  // The start of the template is a word boundary; the start of a later part is
  // not (`ts_${x}from ${t}` must not read as a keyword).
  const boundedBefore = index === 0 ? " " + before : before;
  const isQualifier = tableQualifierExec(after) !== null;
  const isRelation = tableRelationExec(boundedBefore) !== null;
  // A comment opened in ANY earlier part can swallow the substitutions between it and the keyword
  // (`-- ${x} FROM\n ${t}`), so the keyword this part shows would sit inside the comment.
  let commented = false;
  for (let i = 0; i <= index; i++) commented ||= commentMarkerExec(strings[i]) !== null;
  if (commented || (!isQualifier && !isRelation)) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.TOKEN_TABLE,
      "trustedSql: a table may be substituted only after FROM, JOIN, UPDATE, INTO or ONLY, " +
        "or directly before a dot",
    );
  }
}

/**
 * Tagged-template builder. Each substitution must be a genuine
 * `SqlIdentifier` / `SqlTable` / `SqlFragment`, or a non-negative safe integer — anything
 * else throws. Intended as a template tag only (`` trustedSql`…` ``); this
 * function has no way to tell a real template-strings object from a forged
 * array, so that restriction is enforced by the AST gate, not here.
 */
export function trustedSql(
  strings: TemplateStringsArray,
  ...parts: ReadonlyArray<SqlIdentifier | SqlTable | SqlFragment | number>
): SqlFragment {
  let text = "";
  const partsLength = parts.length;
  for (let i = 0; i < partsLength; i++) {
    text += strings[i];
    const part = parts[i];
    if (typeof part === "number") {
      if (!isSafeInteger(part) || part < 0) {
        throw new TypeError(
          "trustedSql: numeric substitution must be a non-negative safe integer",
        );
      }
      text += part;
      continue;
    }
    const identifierText = identifierGet(part);
    if (identifierText !== undefined) {
      text += identifierText;
      continue;
    }
    const tableText = tableGet(part);
    if (tableText !== undefined) {
      assertTablePosition(strings, i);
      text += tableText;
      continue;
    }
    const fragmentText = fragmentGet(part);
    if (fragmentText !== undefined) {
      text += fragmentText;
      continue;
    }
    throw new TypeError(
      "trustedSql: substitution must be a genuine SqlIdentifier/SqlTable/SqlFragment " +
        "or a non-negative safe integer",
    );
  }
  text += strings[partsLength];
  // The comment-marker test runs on the ASSEMBLED text, not on the parts: a marker can be built across a
  // substitution (`${f}- ${x}` with a fragment ending in `-`) just as across fragments joined by joinSql.
  // Text that holds one in a comment, a string or a quoted identifier alike is refused, so no fragment can
  // comment out the keyword that a later template's text shows to the table-position test. The static gate refuses
  // a marker in a template's own text (W6). A template with a table substitution met the position test
  // above first, so it keeps that code.
  assertNoCommentMarker("trustedSql", text);
  assertBalanced("trustedSql", text);
  const obj = createGenuineObject();
  fragmentSet(obj, text);
  return obj as unknown as SqlFragment;
}

/**
 * Join identifiers/fragments with a fragment separator, reading only
 * registered text — never a caller-supplied string.
 */
export function joinSql(
  parts: readonly (SqlIdentifier | SqlFragment)[],
  separator: SqlFragment,
): SqlFragment {
  const separatorText = fragmentGet(separator);
  if (separatorText === undefined) {
    throw new TypeError("joinSql: separator must be a genuine SqlFragment");
  }
  let text = "";
  const length = parts.length;
  for (let i = 0; i < length; i++) {
    const part = parts[i];
    const identifierText = identifierGet(part);
    const partText = identifierText !== undefined ? identifierText : fragmentGet(part);
    if (partText === undefined) {
      throw new TypeError(
        "joinSql: every part must be a genuine SqlIdentifier or SqlFragment",
      );
    }
    if (i > 0) {
      text += separatorText;
    }
    text += partText;
  }
  assertNoCommentMarker("joinSql", text);
  const obj = createGenuineObject();
  fragmentSet(obj, text);
  return obj as unknown as SqlFragment;
}

// Stable `code` values on the refusals of renderSql, sqlIdentifier and trustedSql, so a caller can tell a refusal
// from a programming error without parsing the message.
export const RAW_SQL_REFUSAL_CODE = freeze({
  DIGEST_COLUMN: "RAW_SQL_DIGEST_COLUMN",
  UNICODE_ESCAPE: "RAW_SQL_UNICODE_ESCAPE",
  TOKEN_TABLE: "RAW_SQL_TOKEN_TABLE",
  COMMENT_MARKER: "RAW_SQL_COMMENT_MARKER",
  PAREN_BALANCE: "RAW_SQL_PAREN_BALANCE",
} as const);

type RawSqlRefusalCode = (typeof RAW_SQL_REFUSAL_CODE)[keyof typeof RAW_SQL_REFUSAL_CODE];

function refusal(code: RawSqlRefusalCode, message: string): Error {
  const error = new Error(message) as Error & { code: RawSqlRefusalCode };
  error.code = code;
  return error;
}

// Bearer-token digest columns. The bearer passkey gate (C7,
// check-bearer-passkey-gate.mjs) refuses their names in any source literal, but
// identifiers spliced here (`token_${sqlIdentifier("hash")}`, a joinSql of
// parts) only exist as rendered text, so renderSql refuses them at run time: a
// digest lookup must go through the Prisma query builder, where C7 classifies
// it. Spelled with a group so this pattern is not itself such a literal.
const DIGEST_COLUMN_RE = /(?:token|code|replaced_by)_hash/i;
const digestColumnExec = RegExp.prototype.exec.bind(DIGEST_COLUMN_RE) as (
  input: string,
) => RegExpExecArray | null;

// PostgreSQL's Unicode-escape forms: the U-ampersand prefix of an identifier
// or string (`U&"token\005fhash"` spells a digest column without its plain
// text) and its escape-character clause. C7 refuses both in source literals;
// an identifier spliced before a literal `&"..."` only forms one once rendered.
// No-space only, the static rule's set: PostgreSQL reads the prefix only when
// the ampersand directly follows the U, so `u &` is an identifier and an
// operator. Spelled with a group so this pattern is not itself such a literal.
const UNICODE_ESCAPE_RE = /u(?:&|escape)/i;
const unicodeEscapeExec = RegExp.prototype.exec.bind(UNICODE_ESCAPE_RE) as (
  input: string,
) => RegExpExecArray | null;

/**
 * Does `text` name a bearer-token digest column? The predicate renderSql
 * refuses on, for other boundaries that hold SQL text (the retention-GC
 * registry's identifiers).
 */
export function namesDigestColumn(text: string): boolean {
  return digestColumnExec(text) !== null;
}

/**
 * The only way out: text for a genuine `SqlFragment`. An identifier alone is
 * not a fragment. Throws (with a RAW_SQL_REFUSAL_CODE `code`) when the text
 * names a bearer-token digest column or holds a Unicode-escape form.
 */
export function renderSql(fragment: SqlFragment): string {
  const text = fragmentGet(fragment);
  if (text === undefined) {
    throw new TypeError("renderSql: argument must be a genuine SqlFragment");
  }
  if (namesDigestColumn(text)) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.DIGEST_COLUMN,
      "renderSql: rendered SQL names a bearer-token digest column (the tokenHash / codeHash / replacedByHash fields); " +
        "look the digest up through the Prisma query builder",
    );
  }
  if (unicodeEscapeExec(text) !== null) {
    throw refusal(
      RAW_SQL_REFUSAL_CODE.UNICODE_ESCAPE,
      "renderSql: rendered SQL holds a Unicode-escape prefix or its escape clause, " +
        "which can spell a digest column without its plain text",
    );
  }
  return text;
}
