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
 * Two registries (identifier text, fragment text) rather than one: `trustedSql`
 * accepts either kind as a substitution, but `renderSql` accepts only a
 * fragment — an identifier is text for a position, not a full statement — and
 * distinguishing them needs more than a single string value per object.
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
const fragmentRegistry = new WeakMap<object, string>();
const identifierGet = WeakMap.prototype.get.bind(identifierRegistry) as (
  key: unknown,
) => string | undefined;
const identifierSet = WeakMap.prototype.set.bind(identifierRegistry) as (
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
    "SqlIdentifier/SqlFragment must not be converted to a primitive, string, " +
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

/**
 * Mint a genuine `SqlIdentifier` from a lowercase/underscore name that is not
 * a reserved PostgreSQL keyword. Precondition (enforced by review, not here):
 * `name` must be a code constant or a member of a closed literal set, not a
 * caller-supplied string — this regex bounds syntax, not intent (a data-driven
 * name can still choose the wrong table or column).
 */
export function sqlIdentifier(name: string): SqlIdentifier {
  if (typeof name !== "string") {
    throw new TypeError("sqlIdentifier: name must be a string");
  }
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`sqlIdentifier: "${name}" must match ^[a-z_]+$`);
  }
  if (RESERVED_SQL_WORDS.has(name)) {
    throw new Error(`sqlIdentifier: "${name}" is a reserved PostgreSQL keyword`);
  }
  const obj = createGenuineObject();
  identifierSet(obj, name);
  return obj as unknown as SqlIdentifier;
}

/**
 * Tagged-template builder. Each substitution must be a genuine
 * `SqlIdentifier` / `SqlFragment`, or a non-negative safe integer — anything
 * else throws. Intended as a template tag only (`` trustedSql`…` ``); this
 * function has no way to tell a real template-strings object from a forged
 * array, so that restriction is enforced by the AST gate, not here.
 */
export function trustedSql(
  strings: TemplateStringsArray,
  ...parts: ReadonlyArray<SqlIdentifier | SqlFragment | number>
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
    const fragmentText = fragmentGet(part);
    if (fragmentText !== undefined) {
      text += fragmentText;
      continue;
    }
    throw new TypeError(
      "trustedSql: substitution must be a genuine SqlIdentifier/SqlFragment " +
        "or a non-negative safe integer",
    );
  }
  text += strings[partsLength];
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
  const obj = createGenuineObject();
  fragmentSet(obj, text);
  return obj as unknown as SqlFragment;
}

/** The only way out: text for a genuine `SqlFragment`. An identifier alone is not a fragment. */
export function renderSql(fragment: SqlFragment): string {
  const text = fragmentGet(fragment);
  if (text === undefined) {
    throw new TypeError("renderSql: argument must be a genuine SqlFragment");
  }
  return text;
}
