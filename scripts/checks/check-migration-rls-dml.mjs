#!/usr/bin/env node
/**
 * CI guard: a migration must not read or write a FORCE-RLS table without an
 * RLS bypass that covers it.
 *
 * Why: compose and CI migrate as a superuser, which bypasses RLS, so a backfill
 * that sets no bypass looks fine there. On a migrate role without BYPASSRLS
 * (RDS's master, the managed-Postgres admin) every statement over a FORCE table
 * sees no rows and the backfill silently does nothing.
 *
 * Control class: best-effort tripwire over SQL TEXT (tokenizeSql, no catalog,
 * no binding). Dynamic SQL is not decidable from text, so the gate does not try:
 * inside a DO body an EXECUTE is read only when its whole expression is ONE
 * plain string literal; any other EXECUTE is a MIGRATION_RLS_DML_DYNAMIC finding.
 * Known bypasses (not detected): a table reached through a view, function,
 * trigger or rule by name (incl. REFRESH MATERIALIZED VIEW); DML inside a
 * function or procedure body that a migration creates and later calls;
 * `ALTER TABLE … SET SCHEMA`; DROP and re-CREATE of a forced table (FORCE
 * membership is neither moved nor reset); `CREATE POLICY` / view / function
 * text is never read as a statement.
 *
 * Model:
 *   - FORCE state is replayed per statement in migration name order
 *     (`FORCE` adds, `NO FORCE` removes, `ALTER TABLE t RENAME TO t2` moves).
 *   - Units: the top level, each `DO` body (re-tokenized), and the text of a
 *     single-literal EXECUTE inside a DO body (a nested unit, scanned with the
 *     same rules; its bypass state is the enclosing body's at that point).
 *     Function and procedure bodies are not units.
 *   - In a DO unit every table-introducing position (FROM incl. comma items,
 *     JOIN, UPDATE, INSERT INTO [AS a] [(cols)] [OVERRIDING … VALUE] TABLE t,
 *     DELETE FROM, USING, MERGE INTO [ONLY], and the `TABLE t` query form at a
 *     statement start, after a set operator, `AS`, `(`, `IN`, a CTE list's
 *     closing paren or `CURSOR [WITH HOLD] FOR`) is a reference. At the top
 *     level only data statements are read (SELECT / INSERT / UPDATE / DELETE /
 *     MERGE / WITH / TABLE, `CREATE TABLE|MATERIALIZED VIEW … AS <query>`).
 *     LOCK / TRUNCATE / ON / ADD / FOR TABLE are not references.
 *   - A reference to a FORCE table is refused unless the lexically current
 *     `app.bypass_rls` is 'on' and the current `app.bypass_tables` literal
 *     lists the table. Top-level references are always refused. String
 *     literals other than a single EXECUTE operand are never read, so RAISE
 *     prose naming a table is fine.
 *
 * MIGRATION_RLS_DML_DYNAMIC (baselinable): an EXECUTE in a DO body whose
 * expression is not exactly one string literal: `||`, `format(…)`, a variable,
 * a function call, a parenthesised or adjacent literal. EXECUTE FUNCTION /
 * PROCEDURE (trigger) and GRANT EXECUTE ON are not EXECUTE statements.
 *
 * Fail-closed (MIGRATION_RLS_DML_UNPARSED, never baselinable): unterminated or
 * unrecognised dollar quote; DO without a dollar-quoted body; an EXECUTE
 * literal that is `U&'…'`, an E-string with a backslash escape other than `\'`
 * and `\\`, or holds an unterminated `$` quote; FORCE ROW LEVEL SECURITY or
 * `ALTER TABLE <forced> RENAME TO` inside a DO body or an EXECUTE literal; `DO`
 * or a prepared-statement EXECUTE inside an EXECUTE literal; `SET|RESET [LOCAL|SESSION]
 * app.bypass_*` anywhere; `RESET ALL`, or a SET / RESET whose name is not a
 * plain word, once the unit has granted; `set_config(` whose first argument is
 * not a plain `'…'` literal; `set_config(…, false)` on a bypass setting; any
 * `set_config` of a bypass setting inside an EXECUTE literal or inside a
 * nested block, branch, loop or exception handler (grants AND restores must sit
 * at the body's top block); a grant never restored by the end of the DO body.
 *
 * Output:
 *   MIGRATION_RLS_DML: <dir>:<line>: <table>
 *   MIGRATION_RLS_DML_DYNAMIC: <dir>:<line>
 *   MIGRATION_RLS_DML_UNPARSED: <dir>:<line>: <reason>
 *   ALLOWLIST_ENTRY_WITHOUT_REASON: <line>
 *   STALE_ALLOWLIST_ENTRY: <dir>
 *
 * `--list` prints every hit `<dir>:<line>:<table>` and every dynamic EXECUTE
 * `MIGRATION_RLS_DML_DYNAMIC: <dir>:<line>` (baseline included) and a
 * trailer `FORCE_STATEMENTS=<n> FORCED_TABLES=<n>`.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tokenizeSql, TOKEN, nameOf } from "./lib/sql-scan.mjs";
import { MIN_REASON_LENGTH, parseReasonedAllowlist } from "./lib/reasoned-allowlist.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT_OVERRIDE = process.env.MIGRATION_RLS_DML_CHECK_ROOT;
const ROOT = ROOT_OVERRIDE ?? REPO_ROOT;
const BASELINE_FILE =
  process.env.MIGRATION_RLS_DML_CHECK_BASELINE ??
  join(ROOT, "scripts/checks/migration-rls-dml-baseline.txt");


// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const isWord = (t, upper) => t !== undefined && t.type === TOKEN.WORD && t.upper === upper;
const isForceRls = (tokens, k) =>
  isWord(tokens[k], "FORCE") && isWord(tokens[k + 1], "ROW") && isWord(tokens[k + 2], "LEVEL") && isWord(tokens[k + 3], "SECURITY");
const isName = (t) => t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT);

/** Words that end a FROM list or cannot be an alias. */
const LIST_END = new Set([
  "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "WINDOW", "UNION",
  "INTERSECT", "EXCEPT", "RETURNING", "FOR", "INTO", "LOOP", "THEN", "WHEN", "ELSE",
  "ELSIF", "END", "SET", "VALUES", "SELECT", "WITH", "FROM",
]);
const NOT_ALIAS = new Set([
  ...LIST_END, "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "ON", "USING",
  "AND", "OR", "LATERAL", "TABLESAMPLE", "OUTER",
]);

/** `name[.name…]` at `i`; returns { parts, last, end } or null. */
function chainAt(tokens, i) {
  if (!isName(tokens[i])) return null;
  const parts = [nameOf(tokens[i])];
  let last = i;
  let j = i + 1;
  while (tokens[j]?.type === TOKEN.DOT && isName(tokens[j + 1])) {
    parts.push(nameOf(tokens[j + 1]));
    last = j + 1;
    j += 2;
  }
  return { parts, last, end: j };
}

/** Table key of a chain: `public.` stripped; any other schema stays dotted (never forced). */
function tableKey(parts) {
  const p = parts[0] === "public" && parts.length > 1 ? parts.slice(1) : parts;
  return p.join(".");
}

/** The paren-group enclosing token `k`, as the index of its `(`, or -1. */
function enclosingOpen(tokens, k) {
  const d = tokens[k].depth;
  for (let j = k - 1; j >= 0; j--) {
    if (tokens[j].type === TOKEN.LPAREN && tokens[j].depth === d - 1 && tokens[j].match > k) return j;
  }
  return -1;
}

const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT"]);
const isSetOp = (t) => t?.type === TOKEN.WORD && SET_OPS.has(t.upper);

/**
 * `TABLE t` used as a query: at the start of a statement, after a set operator
 * (`UNION [ALL|DISTINCT]`), `AS` (CTAS), `(`, `IN` (`FOR r IN TABLE t`), the
 * closing paren of a WITH list, or `CURSOR [WITH HOLD] FOR`. `ALTER|CREATE|
 * DROP|LOCK … TABLE`, `ON TABLE` and `ADD|FOR TABLE` never match.
 */
function isTableQueryForm(tokens, k, start, ctes) {
  if (k === start) return true;
  const prev = tokens[k - 1];
  if (prev.type === TOKEN.LPAREN || isWord(prev, "AS") || isWord(prev, "IN") || isSetOp(prev)) return true;
  if (prev.type === TOKEN.RPAREN && ctes.some((c) => c.close === k - 1)) return true;
  if (isWord(prev, "FOR")) return isWord(tokens[k - 2], "CURSOR") || isWord(tokens[k - 2], "HOLD");
  return (isWord(prev, "ALL") || isWord(prev, "DISTINCT")) && isSetOp(tokens[k - 2]);
}

const FROM_FUNCTIONS = new Set(["EXTRACT", "SUBSTRING", "TRIM", "OVERLAY", "POSITION"]);

/** CTE definitions in [start, end): `{ name, from, until, close }` visibility windows. */
function findCtes(tokens, start, end) {
  const out = [];
  for (let w = start; w < end; w++) {
    if (!isWord(tokens[w], "WITH")) continue;
    let i = w + 1;
    const recursive = isWord(tokens[i], "RECURSIVE");
    if (recursive) i++;
    const found = [];
    for (;;) {
      if (!isName(tokens[i])) break;
      const name = nameOf(tokens[i]);
      i++;
      if (tokens[i]?.type === TOKEN.LPAREN && tokens[i].match !== undefined) i = tokens[i].match + 1;
      if (!isWord(tokens[i], "AS")) break;
      i++;
      if (isWord(tokens[i], "NOT") && isWord(tokens[i + 1], "MATERIALIZED")) i += 2;
      else if (isWord(tokens[i], "MATERIALIZED")) i++;
      if (tokens[i]?.type !== TOKEN.LPAREN || tokens[i].match === undefined) break;
      found.push({ name, open: i, close: tokens[i].match });
      i = tokens[i].match + 1;
      if (tokens[i]?.type === TOKEN.COMMA) {
        i++;
        continue;
      }
      break;
    }
    if (found.length === 0) continue;
    let until = end;
    for (let k = found[found.length - 1].close; k < end; k++) {
      if (tokens[k].type === TOKEN.SEMI) {
        until = k;
        break;
      }
    }
    for (const c of found) out.push({ name: c.name, from: recursive ? c.open : c.close + 1, until, close: c.close });
  }
  return out;
}

/**
 * Table references in tokens[start, end): `{ table, index, line }` (line is the
 * 0-based line of the name token within the token array).
 */
export function findReferences(tokens, start, end) {
  const refs = new Map(); // name-token index -> ref
  const ctes = findCtes(tokens, start, end);
  const add = (chain) => {
    const table = tableKey(chain.parts);
    const k = chain.last;
    if (ctes.some((c) => c.name === table && k > c.from && k < c.until)) return;
    if (!refs.has(k)) refs.set(k, { table, index: k, line: tokens[k].line });
  };

  // `TABLE [ONLY] t` as a query (shorthand for SELECT * FROM t) at `k`.
  const tableForm = (k) => {
    let i = k + 1;
    if (isWord(tokens[i], "ONLY")) i++;
    const chain = chainAt(tokens, i);
    if (chain) add(chain);
  };

  // One FROM-clause item at `i`; returns the index after the item (and alias).
  const fromItem = (i) => {
    if (isWord(tokens[i], "LATERAL")) i++;
    if (isWord(tokens[i], "ONLY")) i++;
    if (tokens[i]?.type === TOKEN.LPAREN) {
      i = tokens[i].match === undefined ? i + 1 : tokens[i].match + 1;
    } else {
      const chain = chainAt(tokens, i);
      if (!chain) return i;
      if (tokens[chain.end]?.type === TOKEN.LPAREN) {
        // function call in FROM / JOIN: not a table
        i = tokens[chain.end].match === undefined ? chain.end + 1 : tokens[chain.end].match + 1;
      } else {
        add(chain);
        i = chain.end;
      }
    }
    // [AS] alias [(cols)]
    if (isWord(tokens[i], "AS") && isName(tokens[i + 1])) i += 2;
    else if (
      tokens[i] !== undefined &&
      (tokens[i].type === TOKEN.QIDENT || (tokens[i].type === TOKEN.WORD && !NOT_ALIAS.has(tokens[i].upper)))
    ) {
      i++;
    }
    if (tokens[i]?.type === TOKEN.LPAREN && tokens[i].match !== undefined && isName(tokens[i - 1])) {
      i = tokens[i].match + 1;
    }
    return i;
  };

  // A FROM / USING list: items separated by commas at the keyword's depth.
  const fromList = (kw) => {
    const d = tokens[kw].depth;
    let i = fromItem(kw + 1);
    for (;;) {
      let j = i;
      let comma = -1;
      for (; j < end; j++) {
        const t = tokens[j];
        if (t.depth < d || t.type === TOKEN.SEMI) break;
        if (t.depth > d) continue;
        if (t.type === TOKEN.COMMA) {
          comma = j;
          break;
        }
        if (t.type === TOKEN.WORD && LIST_END.has(t.upper)) break;
        if (isWord(t, "ON") && isWord(tokens[j + 1], "CONFLICT")) break;
      }
      if (comma === -1) return;
      i = fromItem(comma + 1);
    }
  };

  for (let k = start; k < end; k++) {
    const t = tokens[k];
    if (t.type !== TOKEN.WORD) continue;
    const prev = tokens[k - 1];
    if (t.upper === "FROM") {
      if (isWord(prev, "DISTINCT")) continue;
      const open = enclosingOpen(tokens, k);
      if (open > 0 && tokens[open - 1].type === TOKEN.WORD && FROM_FUNCTIONS.has(tokens[open - 1].upper)) continue;
      fromList(k);
    } else if (t.upper === "USING") {
      if (tokens[k + 1]?.type === TOKEN.LPAREN) continue;
      fromList(k);
    } else if (t.upper === "JOIN") {
      fromItem(k + 1);
    } else if ((t.upper === "INSERT" || t.upper === "MERGE") && isWord(tokens[k + 1], "INTO")) {
      let i = k + 2;
      if (t.upper === "MERGE" && isWord(tokens[i], "ONLY")) i++;
      const chain = chainAt(tokens, i);
      if (chain) {
        add(chain);
        // INSERT INTO u [AS a] [(cols)] [OVERRIDING {SYSTEM|USER} VALUE] TABLE t: the source of the insert
        let j = chain.end;
        if (isWord(tokens[j], "AS") && isName(tokens[j + 1])) j += 2;
        if (tokens[j]?.type === TOKEN.LPAREN && tokens[j].match !== undefined) j = tokens[j].match + 1;
        if (isWord(tokens[j], "OVERRIDING") && isWord(tokens[j + 2], "VALUE")) j += 3;
        if (t.upper === "INSERT" && isWord(tokens[j], "TABLE")) tableForm(j);
      }
    } else if (t.upper === "TABLE" && isTableQueryForm(tokens, k, start, ctes)) {
      tableForm(k);
    } else if (t.upper === "UPDATE") {
      if (prev !== undefined && prev.type === TOKEN.WORD && ["FOR", "ON", "DO", "KEY", "OF", "OR", "AFTER", "BEFORE"].includes(prev.upper)) continue;
      let i = k + 1;
      if (isWord(tokens[i], "ONLY")) i++;
      const chain = chainAt(tokens, i);
      if (!chain) continue;
      i = chain.end;
      if (tokens[i]?.type === TOKEN.OP && tokens[i].text === "*") i++;
      if (isWord(tokens[i], "AS") && isName(tokens[i + 1])) i += 2;
      else if (isName(tokens[i]) && !isWord(tokens[i], "SET")) i++;
      if (isWord(tokens[i], "SET")) add(chain);
    }
  }
  return [...refs.values()].sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Dollar-quote normalisation (fail closed on anything unrecognised)
// ---------------------------------------------------------------------------

// PostgreSQL treats every character >= U+0080 as an identifier character.
const wordChar = (c) => c !== undefined && /[A-Za-z0-9_$\u0080-\u{10FFFF}]/u.test(c);
// Tag rule of check-destructive-migration.mjs: Unicode letters are legal. A tag
// never contains `$` (PostgreSQL), else `$q$x$q$` would lex as ONE tag.
const DOLLAR_TAG = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
// What sql-scan's tokenizer recognises as a dollar tag.
const ASCII_TAG_SRC = String.raw`\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$`;
const ASCII_TAG = new RegExp(`^${ASCII_TAG_SRC}$`);
const ASCII_TAG_PREFIX = new RegExp(`^${ASCII_TAG_SRC}`);

/**
 * sql-scan only lexes ASCII dollar tags. Rewrite every other legal tag to an
 * ASCII one (the same tag always maps to the same ASCII tag; line numbers are
 * unchanged) and report an unterminated or unrecognised `$` quote.
 *
 * @returns {{ sql: string, errors: { line: number, reason: string }[] }}
 */
export function normalizeDollarTags(sql) {
  const errors = [];
  const tagMap = new Map();
  let out = "";
  let line = 0;
  let i = 0;
  const copy = (to) => {
    const piece = sql.slice(i, to);
    for (const ch of piece) if (ch === "\n") line++;
    out += piece;
    i = to;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < sql.length && sql[j] !== "\n") j++;
      copy(j);
    } else if (c === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      let nest = 1;
      while (j < sql.length && nest > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          nest++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          nest--;
          j += 2;
        } else j++;
      }
      copy(j);
    } else if (c === "'" || ((c === "E" || c === "e") && sql[i + 1] === "'" && !wordChar(sql[i - 1]))) {
      const escapes = c !== "'";
      let j = i + (escapes ? 2 : 1);
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      copy(Math.min(j, sql.length));
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      copy(Math.min(j, sql.length));
    } else if (c === "$" && !wordChar(sql[i - 1]) && !/[0-9]/.test(sql[i + 1] ?? "")) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (!m) {
        errors.push({ line, reason: "unrecognised dollar quote" });
        copy(i + 1);
        continue;
      }
      const tag = m[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        errors.push({ line, reason: "unterminated dollar quote" });
        copy(sql.length);
        break;
      }
      let mapped = tag;
      if (!ASCII_TAG.test(tag)) {
        if (!tagMap.has(tag)) tagMap.set(tag, `$ZZunicodetag${tagMap.size}$`);
        mapped = tagMap.get(tag);
      }
      const body = sql.slice(i + tag.length, close);
      for (const ch of body) if (ch === "\n") line++;
      out += mapped + body + mapped;
      i = close + tag.length;
    } else {
      copy(i + 1);
    }
  }
  return { sql: out, errors };
}

// ---------------------------------------------------------------------------
// FORCE replay
// ---------------------------------------------------------------------------

/**
 * FORCE / NO FORCE occurrences of one top-level statement, `{ table, force }`,
 * and `ALTER TABLE t RENAME TO t2` as `{ rename: { from, to } }`.
 */
function forceEvents(tokens, s, e) {
  if (!isWord(tokens[s], "ALTER") || !isWord(tokens[s + 1], "TABLE")) return [];
  let i = s + 2;
  if (isWord(tokens[i], "IF") && isWord(tokens[i + 1], "EXISTS")) i += 2;
  if (isWord(tokens[i], "ONLY")) i++;
  const chain = chainAt(tokens, i);
  if (!chain) return [];
  const table = tableKey(chain.parts);
  const out = [];
  if (isWord(tokens[chain.end], "RENAME") && isWord(tokens[chain.end + 1], "TO")) {
    const to = chainAt(tokens, chain.end + 2);
    if (to) out.push({ rename: { from: table, to: tableKey(to.parts) } });
  }
  for (let k = chain.end; k < e; k++) {
    if (isForceRls(tokens, k)) {
      out.push({ table, force: !isWord(tokens[k - 1], "NO") });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DO-body state machine
// ---------------------------------------------------------------------------

const STMT_PREV = new Set(["THEN", "ELSE", "LOOP", "BEGIN"]);

/** Does a statement start at token `k` (unit start, after `;`, or after THEN / ELSE / LOOP / BEGIN)? */
const atStmtStart = (tokens, k) =>
  k === 0 || tokens[k - 1].type === TOKEN.SEMI || (tokens[k - 1].type === TOKEN.WORD && STMT_PREV.has(tokens[k - 1].upper));

/** Block-nesting depth at every token of a PL/pgSQL body (1 = inside the outer BEGIN). */
function blockDepths(tokens) {
  const depths = new Array(tokens.length).fill(0);
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    depths[k] = stack.length;
    const t = tokens[k];
    if (t.type !== TOKEN.WORD) continue;
    if (t.upper === "BEGIN") stack.push("BEGIN");
    else if (t.upper === "IF" && !isWord(tokens[k - 1], "END") && atStmtStart(tokens, k)) stack.push("IF");
    else if (t.upper === "CASE" && !isWord(tokens[k - 1], "END")) stack.push(atStmtStart(tokens, k) ? "CASE" : "ECASE");
    else if (t.upper === "LOOP" && !isWord(tokens[k - 1], "END")) stack.push("LOOP");
    else if (t.upper === "EXCEPTION" && isWord(tokens[k + 1], "WHEN")) stack.push("HANDLER");
    else if (t.upper === "END") {
      const next = tokens[k + 1];
      if (isWord(next, "IF") || isWord(next, "LOOP") || isWord(next, "CASE")) stack.pop();
      else if (stack[stack.length - 1] === "ECASE") stack.pop();
      else {
        while (stack[stack.length - 1] === "HANDLER") stack.pop();
        stack.pop();
      }
    }
  }
  return depths;
}

/** `EXECUTE FUNCTION|PROCEDURE` (trigger) and `GRANT EXECUTE ON` (privilege) are not dynamic SQL. */
function isExecutePrivilegeOrTrigger(tokens, k) {
  const next = tokens[k + 1];
  return isWord(next, "FUNCTION") || isWord(next, "PROCEDURE") || isWord(next, "ON") || next?.type === TOKEN.COMMA;
}

/** A dollar-quoted token's body (its tags removed), or null when it is not one. */
function dollarBody(text) {
  const tag = ASCII_TAG_PREFIX.exec(text);
  return tag && text.length >= 2 * tag[0].length ? text.slice(tag[0].length, text.length - tag[0].length) : null;
}

/**
 * The text a PLAIN string literal denotes: `'…'` (`''` resolved), `$tag$…$tag$`,
 * or an E-string whose only backslash escapes are `\'` and `\\`. Null for any
 * other E-string (an octal / hex / unicode escape can spell a `;` or a name no
 * token carries) and for an unterminated literal.
 */
function plainLiteralText(text) {
  if (text.startsWith("$")) return dollarBody(text);
  const escapes = text[0] === "E" || text[0] === "e";
  const inner = text.slice(escapes ? 2 : 1);
  let out = "";
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (c === "'") {
      if (inner[j + 1] === "'") {
        out += "'";
        j++;
        continue;
      }
      return j === inner.length - 1 ? out : null;
    }
    if (escapes && c === "\\") {
      const n = inner[j + 1];
      if (n !== "'" && n !== "\\") return null;
      out += n;
      j++;
      continue;
    }
    out += c;
  }
  return null;
}

/** `SET|RESET [LOCAL|SESSION] app.bypass_*` at token `k`: the lexical bypass state becomes unknowable. */
function isBypassSetting(tokens, k) {
  if (!isWord(tokens[k], "SET") && !isWord(tokens[k], "RESET")) return false;
  let i = k + 1;
  if (isWord(tokens[i], "LOCAL") || isWord(tokens[i], "SESSION")) i++;
  const chain = chainAt(tokens, i);
  return chain !== null && chain.parts.join(".").toLowerCase().startsWith("app.bypass_");
}

/** Is the name of the SET / RESET at `k` a `word[.word…]` of plain words (and not `RESET ALL`)? */
function hasPlainSettingName(tokens, k) {
  let i = k + 1;
  if (isWord(tokens[i], "LOCAL") || isWord(tokens[i], "SESSION")) i++;
  if (isWord(tokens[k], "RESET") && isWord(tokens[i], "ALL")) return false;
  if (tokens[i]?.type !== TOKEN.WORD) return false;
  while (tokens[i + 1]?.type === TOKEN.DOT) {
    if (tokens[i + 2]?.type !== TOKEN.WORD) return false;
    i += 2;
  }
  return true;
}

/** Split the arguments of the call whose `(` is at `open`: arrays of token indexes. */
function callArgs(tokens, open) {
  const close = tokens[open].match;
  if (close === undefined) return null;
  const args = [[]];
  for (let j = open + 1; j < close; j++) {
    if (tokens[j].type === TOKEN.COMMA && tokens[j].depth === tokens[open].depth + 1) args.push([]);
    else args[args.length - 1].push(j);
  }
  return args;
}

const literalOf = (tokens, arg) => {
  if (arg?.length !== 1) return null;
  const t = tokens[arg[0]];
  if (t.type !== TOKEN.STRING || !t.text.startsWith("'")) return null;
  return t.text.slice(1, -1).replace(/''/g, "'");
};

/**
 * What an EXECUTE at `k` runs: `{ text, line }` for exactly one plain string
 * literal, `{ unparsed }` for one that cannot be unquoted (`U&'…'`, an E-string
 * with another escape), else `{ dynamic: true }` (`||`, format(), a variable …).
 */
function executeOperand(tokens, k) {
  const expr = [];
  for (let j = k + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === TOKEN.SEMI || (t.depth === tokens[k].depth && (isWord(t, "INTO") || isWord(t, "USING")))) break;
    expr.push(t);
  }
  if (expr.length === 3 && isWord(expr[0], "U") && expr[1].type === TOKEN.OP && expr[1].text === "&" && expr[2].type === TOKEN.STRING) {
    return { unparsed: "EXECUTE of a U&'…' literal" };
  }
  if (expr.length !== 1 || expr[0].type !== TOKEN.STRING) return { dynamic: true };
  const text = plainLiteralText(expr[0].text);
  if (text === null) return { unparsed: "EXECUTE of an E-string with an escape other than \\' and \\\\, or an unterminated literal" };
  return { text, line: expr[0].line };
}

/**
 * Scan one statement list: a DO body, or (`nested`) the text of the single-literal
 * EXECUTE it runs. `st` is the lexical bypass state, shared so a nested unit
 * starts from the enclosing body's state at the EXECUTE. Findings go to `out`
 * (`hits`, `errors`, `dynamic`) with `lineBase` added to the unit's 0-based lines.
 */
function scanUnit(tokens, forced, st, out, lineBase, nested) {
  const depths = nested ? null : blockDepths(tokens);
  const where = nested ? "an EXECUTE literal" : "a DO body";
  const fail = (tok, reason) => out.errors.push({ line: lineBase + tok.line, reason });

  const events = findReferences(tokens, 0, tokens.length).map((ref) => ({ index: ref.index, ref }));
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === TOKEN.WORD && atStmtStart(tokens, k) && (t.upper === "ALTER" || (nested && t.upper === "DO"))) {
      if (t.upper === "DO") fail(t, "DO inside an EXECUTE literal");
      else {
        let e = k;
        while (e < tokens.length && tokens[e].type !== TOKEN.SEMI) e++;
        if (forceEvents(tokens, k, e).some((ev) => ev.rename && forced.has(ev.rename.from))) {
          fail(t, `ALTER TABLE <FORCE table> RENAME TO inside ${where}`);
        }
      }
    }
    if (isName(t) && nameOf(t) === "set_config" && tokens[k + 1]?.type === TOKEN.LPAREN) events.push({ index: k, call: k + 1 });
    else if (isWord(t, "EXECUTE") && !isExecutePrivilegeOrTrigger(tokens, k)) events.push({ index: k, exec: true });
    else if (isWord(t, "SET") || isWord(t, "RESET")) {
      if (isBypassSetting(tokens, k)) fail(t, `SET / RESET of an app.bypass_* setting inside ${where} (lexical state unknown)`);
      else if (atStmtStart(tokens, k) && !hasPlainSettingName(tokens, k)) events.push({ index: k, unknownSetting: true });
    } else if (isForceRls(tokens, k)) fail(t, `FORCE ROW LEVEL SECURITY inside ${where}`);
  }
  events.sort((a, b) => a.index - b.index);

  for (const ev of events) {
    const tok = tokens[ev.index];
    if (ev.ref) {
      if (forced.has(ev.ref.table) && !(st.on && st.tables !== null && st.tables.has(ev.ref.table))) {
        out.hits.push({ line: lineBase + ev.ref.line, table: ev.ref.table });
      }
    } else if (ev.unknownSetting) {
      if (st.granted) fail(tok, "RESET ALL or a SET / RESET with a non-plain name after a bypass grant (restore state unknown)");
    } else if (ev.exec) {
      const op = nested ? null : executeOperand(tokens, ev.index);
      if (op === null) fail(tok, "EXECUTE (prepared statement) inside an EXECUTE literal");
      else if (op.unparsed) fail(tok, op.unparsed);
      else if (op.dynamic) out.dynamic.push({ line: lineBase + tok.line });
      else {
        const inner = normalizeDollarTags(op.text);
        if (inner.errors.length > 0) fail(tok, "EXECUTE literal holds an unterminated or unrecognised $ quote");
        else scanUnit(tokenizeSql(inner.sql), forced, st, out, lineBase + op.line, true);
      }
    } else {
      const args = callArgs(tokens, ev.call);
      if (args === null) {
        fail(tok, "set_config call cannot be parsed");
        continue;
      }
      const setting = literalOf(tokens, args[0])?.toLowerCase();
      if (setting === undefined) {
        fail(tok, "set_config with a first argument that is not a plain 'literal'");
        continue;
      }
      if (setting !== "app.bypass_rls" && setting !== "app.bypass_tables") continue;
      if (nested) {
        fail(tok, `set_config of ${setting} inside an EXECUTE literal`);
        continue;
      }
      if (depths[ev.index] !== 1) {
        fail(tok, "bypass setting (grant or restore) inside a nested block, branch or loop");
        continue;
      }
      if (args.length !== 3) {
        fail(tok, "set_config call without three arguments");
        continue;
      }
      const local = args[2].length === 1 ? tokens[args[2][0]] : null;
      if (isWord(local, "FALSE")) {
        fail(tok, `set_config('${setting}', ..., false) is session-scoped`);
        continue;
      }
      const isLocal = isWord(local, "TRUE");
      const value = literalOf(tokens, args[1]);
      if (setting === "app.bypass_rls") {
        st.on = value?.toLowerCase() === "on" && isLocal;
        if (st.on) {
          st.granted = true;
          st.lastGrantLine = lineBase + tok.line;
        }
      } else {
        st.tables = value !== null && isLocal ? new Set(value.split(",")) : null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Migration scan
// ---------------------------------------------------------------------------

const DATA_HEADS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "TABLE"]);

function isDataStatement(tokens, s, e) {
  const head = tokens[s];
  if (head === undefined) return false;
  if (head.type === TOKEN.WORD && DATA_HEADS.has(head.upper)) return true;
  if (isWord(head, "CREATE")) {
    let hasTable = false;
    for (let k = s + 1; k < e; k++) {
      if (isWord(tokens[k], "TABLE") || (isWord(tokens[k], "MATERIALIZED") && isWord(tokens[k + 1], "VIEW"))) hasTable = true;
      if (hasTable && tokens[k].depth === head.depth && isWord(tokens[k], "AS")) {
        const n = tokens[k + 1];
        return n !== undefined && (isWord(n, "SELECT") || isWord(n, "WITH") || isWord(n, "VALUES") || isWord(n, "TABLE") || n.type === TOKEN.LPAREN);
      }
    }
  }
  return false;
}

/**
 * Scan one migration's SQL against the FORCE set carried in (mutated).
 * @returns {{ hits: {line:number, table:string}[], errors: {line:number, reason:string}[],
 *            dynamic: {line:number}[], forceStatements: number, forcedTables: Set<string> }}
 */
export function scanSql(sql, forced) {
  const hits = [];
  const errors = [];
  const dynamic = [];
  let forceStatements = 0;
  const forcedTables = new Set();

  const norm = normalizeDollarTags(sql);
  for (const e of norm.errors) errors.push({ line: e.line + 1, reason: e.reason });
  const tokens = tokenizeSql(norm.sql);

  let s = 0;
  while (s < tokens.length) {
    let e = s;
    while (e < tokens.length && tokens[e].type !== TOKEN.SEMI) e++;
    if (e > s) {
      for (const ev of forceEvents(tokens, s, e)) {
        if (ev.rename) {
          if (forced.delete(ev.rename.from)) forced.add(ev.rename.to);
        } else if (ev.force) {
          forceStatements++;
          forcedTables.add(ev.table);
          forced.add(ev.table);
        } else {
          forced.delete(ev.table);
        }
      }
      if (isWord(tokens[s], "DO")) {
        const bodyTok = tokens.slice(s, e).find((t) => t.type === TOKEN.STRING && t.text.startsWith("$"));
        const body = bodyTok ? dollarBody(bodyTok.text) : null;
        if (body === null) {
          errors.push({ line: tokens[s].line + 1, reason: "DO without a dollar-quoted body" });
        } else {
          const inner = normalizeDollarTags(body);
          const offset = bodyTok.line + 1;
          for (const err of inner.errors) errors.push({ line: err.line + offset, reason: err.reason });
          const st = { on: false, tables: new Set(), granted: false, lastGrantLine: 0 };
          scanUnit(tokenizeSql(inner.sql), forced, st, { hits, errors, dynamic }, offset, false);
          if (st.on) errors.push({ line: st.lastGrantLine, reason: "bypass_rls granted but not restored by the end of the DO body" });
        }
      } else if (isDataStatement(tokens, s, e)) {
        for (const ref of findReferences(tokens, s, e)) {
          if (forced.has(ref.table)) hits.push({ line: ref.line + 1, table: ref.table });
        }
      }
    }
    s = e + 1;
  }
  return { hits, errors, dynamic, forceStatements, forcedTables };
}

/** Scan every migration under `root` in name order. */
export function scanTree(root) {
  const dir = join(root, "prisma/migrations");
  const result = { hits: [], errors: [], dynamic: [], forceStatements: 0, forcedTables: new Set() };
  if (!existsSync(dir)) return result;
  const forced = new Set();
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    const path = join(dir, name, "migration.sql");
    if (!existsSync(path)) continue;
    const r = scanSql(readFileSync(path, "utf8"), forced);
    for (const h of r.hits) result.hits.push({ dir: name, ...h });
    for (const e of r.errors) result.errors.push({ dir: name, ...e });
    for (const d of r.dynamic) result.dynamic.push({ dir: name, ...d });
    result.forceStatements += r.forceStatements;
    for (const t of r.forcedTables) result.forcedTables.add(t);
  }
  return result;
}

function main() {
  if (process.env.CI && ROOT_OVERRIDE && process.env.MIGRATION_RLS_DML_CHECK_FIXTURE !== "1") {
    console.error(
      "migration-rls-dml: MIGRATION_RLS_DML_CHECK_ROOT is set under CI without " +
        "MIGRATION_RLS_DML_CHECK_FIXTURE=1; refusing to check a tree other than the repo's.",
    );
    process.exit(2);
  }

  const { entries, errors: baselineErrors } = existsSync(BASELINE_FILE)
    ? parseReasonedAllowlist(readFileSync(BASELINE_FILE, "utf8"))
    : { entries: new Map(), errors: [] };
  const scan = scanTree(ROOT);
  const errors = [...baselineErrors];

  if (process.argv.includes("--list")) {
    for (const h of scan.hits) console.log(`${h.dir}:${h.line}:${h.table}`);
    for (const d of scan.dynamic) console.log(`MIGRATION_RLS_DML_DYNAMIC: ${d.dir}:${d.line}`);
    console.log(`FORCE_STATEMENTS=${scan.forceStatements} FORCED_TABLES=${scan.forcedTables.size}`);
    for (const e of scan.errors) console.error(`MIGRATION_RLS_DML_UNPARSED: ${e.dir}:${e.line}: ${e.reason}`);
    process.exit(scan.errors.length > 0 ? 1 : 0);
  }

  const hitDirs = new Set([...scan.hits, ...scan.dynamic].map((h) => h.dir));
  for (const h of scan.hits) {
    if (!entries.has(h.dir)) errors.push(`MIGRATION_RLS_DML: ${h.dir}:${h.line}: ${h.table}`);
  }
  for (const d of scan.dynamic) {
    if (!entries.has(d.dir)) errors.push(`MIGRATION_RLS_DML_DYNAMIC: ${d.dir}:${d.line}`);
  }
  for (const e of scan.errors) errors.push(`MIGRATION_RLS_DML_UNPARSED: ${e.dir}:${e.line}: ${e.reason}`);
  for (const name of entries.keys()) {
    if (!hitDirs.has(name)) errors.push(`STALE_ALLOWLIST_ENTRY: ${name}`);
  }

  if (errors.length > 0) {
    console.error("Migration RLS-DML check FAILED:\n");
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      `\nA migration statement reads or writes a table under FORCE ROW LEVEL SECURITY` +
        `\nwithout a bypass covering it. On a migrate role without BYPASSRLS (RDS master,` +
        `\nmanaged-Postgres admin) it sees no rows and silently does nothing. Wrap the` +
        `\nbackfill in a DO block that sets app.bypass_rls = 'on' and app.bypass_tables to` +
        `\nthe exact tables (transaction-local), and restores them after. Pattern:` +
        `\n  prisma/migrations/20261109162613_*/migration.sql` +
        `\nMIGRATION_RLS_DML_DYNAMIC: an EXECUTE in a DO body that is not exactly one plain` +
        `\nstring literal cannot be read; write the statement as one literal.` +
        `\nAn already-shipped migration may be baselined in ${BASELINE_FILE}:` +
        `\n  <migration_dir_name>  # reason of at least ${MIN_REASON_LENGTH} characters\n`,
    );
    process.exit(1);
  }
  console.log(`migration-rls-dml: OK (${hitDirs.size} baselined migrations, no new hits)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
