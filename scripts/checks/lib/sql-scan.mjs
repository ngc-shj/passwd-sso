/**
 * Lexical SQL scanner shared by two tripwires (plan: worker-batch-limit-overrun):
 *
 *   - C2, scripts/checks/check-limited-subquery-write.mjs — a LIMIT/FETCH in a
 *     write literal must sit at the top level of a MATERIALIZED CTE body in
 *     the literal's depth-0 WITH list;
 *   - C4, src/__tests__/workers/worker-policy-manifest.test.ts (sweepBounds,
 *     INV4) — a write is bounded when a top-level AND conjunct of its WHERE is
 *     `(<keys>) IN (SELECT <keys> FROM <materialized cte with LIMIT>)`.
 *
 * It reads SQL TEXT, not SQL: no grammar, no binding, no catalog. It knows
 * enough lexical structure that a keyword inside a comment, a string or a
 * quoted identifier is not a keyword, and enough nesting (parenthesis depth,
 * WITH lists, statement position) that "where does this LIMIT sit" has one
 * answer. Anything it does not recognise is left unrecognised; each caller
 * decides whether that denies.
 *
 * Input is a literal's text split around its template substitutions:
 * `{ parts: string[], substitutions: string[] }` with
 * `parts.length === substitutions.length + 1` (the cooked text of a template
 * literal's head/middles/tail, and each `${…}` expression's source text). A
 * substitution is ONE opaque token: the scanner never looks inside it, so a
 * fragment built elsewhere and interpolated is invisible here by construction.
 *
 * Tokens carry `depth`: the parenthesis depth they sit at, where an opening
 * paren and its matching closing paren share the depth OUTSIDE the group and
 * every token between them is one deeper. Unbalanced text (a fragment) is
 * tolerated — depth may go negative, and an unmatched paren has no `match`.
 */
import { Node } from "ts-morph";

/** Private-use placeholder occupying a substitution's offset while lexing. */
const SUB = "\uE000";

export const TOKEN = Object.freeze({
  WORD: "word",
  QIDENT: "qident",
  STRING: "string",
  NUMBER: "number",
  PARAM: "param",
  OPAQUE: "opaque",
  LPAREN: "lparen",
  RPAREN: "rparen",
  COMMA: "comma",
  SEMI: "semi",
  DOT: "dot",
  OP: "op",
});

// ---------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------

/** Plain text with no substitutions. */
function inputFromString(text) {
  return { parts: [text], substitutions: [] };
}

/**
 * Build scanner input from a ts-morph literal node: a StringLiteral, a
 * NoSubstitutionTemplateLiteral or a TemplateExpression (tagged or not — the
 * tag is never consulted). Returns null for any other node.
 */
export function sqlInputFromNode(node) {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return inputFromString(node.getLiteralText());
  }
  if (Node.isTemplateExpression(node)) {
    const parts = [node.getHead().getLiteralText()];
    const substitutions = [];
    for (const span of node.getTemplateSpans()) {
      substitutions.push(span.getExpression().getText());
      parts.push(span.getLiteral().getLiteralText());
    }
    return { parts, substitutions };
  }
  return null;
}

/**
 * Build scanner input from template SOURCE text — `…${expr}…`, optionally
 * wrapped in backticks (what `node.getText()` returns). `${` opens a
 * substitution; its end is found by brace counting that skips quoted JS
 * strings. Used where only the text is at hand (unit tests, callers that
 * already hold `getText()`); a caller holding the node should prefer
 * sqlInputFromNode, which reads the parser's own spans.
 */
export function sqlInputFromSourceText(text) {
  let s = text;
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) s = s.slice(1, -1);
  const parts = [];
  const substitutions = [];
  let buf = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      buf += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "{") {
      let j = i + 2;
      let braces = 1;
      while (j < s.length && braces > 0) {
        const c = s[j];
        if (c === "'" || c === '"' || c === "`") {
          j++;
          while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
        } else if (c === "{") braces++;
        else if (c === "}") braces--;
        j++;
      }
      parts.push(buf);
      buf = "";
      substitutions.push(s.slice(i + 2, j - 1));
      i = j;
      continue;
    }
    buf += s[i];
    i++;
  }
  parts.push(buf);
  return { parts, substitutions };
}

function normalizeInput(input) {
  if (typeof input === "string") return inputFromString(input);
  if (!input || !Array.isArray(input.parts) || !Array.isArray(input.substitutions)) {
    throw new TypeError("sql-scan: input must be a string or { parts, substitutions }");
  }
  if (input.parts.length !== input.substitutions.length + 1) {
    throw new TypeError("sql-scan: parts.length must equal substitutions.length + 1");
  }
  return input;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const isWordStart = (c) => /[A-Za-z_\u0080-\uDFFF]/.test(c);
const isWordChar = (c) => /[A-Za-z0-9_$\u0080-\uDFFF]/.test(c);

/**
 * Lex `input` into tokens. Comments (`--` to end of line, nested `/* … *\/`)
 * produce no token; string literals (`'…'` with `''`, `E'…'` with backslash
 * escapes, `$tag$…$tag$`) become one STRING token; `"…"` (with `""`) becomes a
 * QIDENT whose `value` is the unquoted name. Each token has
 * `{ type, text, upper, value, depth, line, index, match }`; `line` is
 * 0-based from the start of the literal; `match` on a paren is the index of
 * its partner (or undefined when unbalanced).
 */
export function tokenizeSql(rawInput) {
  const input = normalizeInput(rawInput);
  const text = input.parts.join(SUB);
  // Substitutions are located by offset, not by searching for SUB, so a
  // literal that itself holds U+E000 lexes that character as an operator.
  const subAt = new Map();
  let offset = 0;
  input.parts.forEach((p, k) => {
    offset += p.length;
    if (k < input.substitutions.length) subAt.set(offset, k);
    offset += 1;
  });
  const tokens = [];
  let depth = 0;
  let line = 0;
  const parenStack = [];

  const countLines = (from, to) => {
    for (let k = from; k < to; k++) {
      if (text[k] === "\n") line++;
      else if (subAt.has(k)) {
        for (const ch of input.substitutions[subAt.get(k)]) if (ch === "\n") line++;
      }
    }
  };
  const push = (type, start, end, extra = {}) => {
    const t = text.slice(start, end);
    tokens.push({
      type,
      text: t,
      upper: type === TOKEN.WORD ? t.toUpperCase() : t,
      depth,
      line,
      index: tokens.length,
      ...extra,
    });
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Whitespace.
    if (/\s/.test(c)) {
      countLines(i, i + 1);
      i++;
      continue;
    }
    // Line comment.
    if (c === "-" && text[i + 1] === "-") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j++;
      countLines(i, j);
      i = j;
      continue;
    }
    // Block comment (PostgreSQL nests them).
    if (c === "/" && text[i + 1] === "*") {
      let j = i + 2;
      let nest = 1;
      while (j < text.length && nest > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          nest++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          nest--;
          j += 2;
        } else j++;
      }
      countLines(i, j);
      i = j;
      continue;
    }
    // Substitution: one opaque token.
    if (subAt.has(i)) {
      const sub = input.substitutions[subAt.get(i)];
      push(TOKEN.OPAQUE, i, i + 1, { text: sub, upper: sub, value: "${" + sub + "}" });
      countLines(i, i + 1);
      i++;
      continue;
    }
    // Escape-string constant E'…' (backslash escapes) — prefix must be a lone E.
    if ((c === "E" || c === "e") && text[i + 1] === "'" && !(i > 0 && isWordChar(text[i - 1]))) {
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push(TOKEN.STRING, i, Math.min(j, text.length));
      countLines(i, Math.min(j, text.length));
      i = j;
      continue;
    }
    // Standard string constant '…' ('' escapes).
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push(TOKEN.STRING, i, Math.min(j, text.length));
      countLines(i, Math.min(j, text.length));
      i = j;
      continue;
    }
    // Quoted identifier "…" ("" escapes).
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += text[j];
        j++;
      }
      push(TOKEN.QIDENT, i, Math.min(j, text.length), { value });
      countLines(i, Math.min(j, text.length));
      i = j;
      continue;
    }
    // `$n` parameter, or a `$tag$ … $tag$` dollar-quoted string.
    if (c === "$") {
      if (/[0-9]/.test(text[i + 1] ?? "")) {
        let j = i + 1;
        while (j < text.length && /[0-9]/.test(text[j])) j++;
        push(TOKEN.PARAM, i, j);
        i = j;
        continue;
      }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const delim = m[0];
        const close = text.indexOf(delim, i + delim.length);
        const j = close === -1 ? text.length : close + delim.length;
        push(TOKEN.STRING, i, j);
        countLines(i, j);
        i = j;
        continue;
      }
      push(TOKEN.OP, i, i + 1);
      i++;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < text.length && isWordChar(text[j])) j++;
      push(TOKEN.WORD, i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE_]/.test(text[j])) j++;
      push(TOKEN.NUMBER, i, j);
      i = j;
      continue;
    }
    if (c === "(") {
      push(TOKEN.LPAREN, i, i + 1);
      parenStack.push(tokens.length - 1);
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      push(TOKEN.RPAREN, i, i + 1);
      const open = parenStack.pop();
      if (open !== undefined) {
        tokens[open].match = tokens.length - 1;
        tokens[tokens.length - 1].match = open;
      }
      i++;
      continue;
    }
    if (c === ",") push(TOKEN.COMMA, i, i + 1);
    else if (c === ";") push(TOKEN.SEMI, i, i + 1);
    else if (c === ".") push(TOKEN.DOT, i, i + 1);
    else push(TOKEN.OP, i, i + 1);
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const isWord = (t, upper) => t !== undefined && t.type === TOKEN.WORD && t.upper === upper;
const isNameToken = (t) =>
  t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT || t.type === TOKEN.OPAQUE);

/** Normalised name of a single name token: lower-cased word, unquoted identifier, or `${expr}`. */
export function nameOf(t) {
  if (t === undefined) return null;
  if (t.type === TOKEN.WORD) return t.text.toLowerCase();
  if (t.type === TOKEN.QIDENT) return t.value;
  if (t.type === TOKEN.OPAQUE) return t.value;
  return null;
}

/**
 * Parse a WITH list starting at token `w` (the WITH keyword). Returns null
 * when the tokens after WITH are not `[RECURSIVE] name [(cols)] AS [NOT]
 * [MATERIALIZED] ( … )`, so `WITH TIME ZONE`, `WITH ORDINALITY`,
 * `WITH (fillfactor = …)` and prose are not WITH lists.
 */
function parseWithList(tokens, w) {
  let i = w + 1;
  let recursive = false;
  if (isWord(tokens[i], "RECURSIVE")) {
    recursive = true;
    i++;
  }
  const ctes = [];
  for (;;) {
    const nameTok = tokens[i];
    if (!isNameToken(nameTok)) return null;
    i++;
    if (tokens[i]?.type === TOKEN.LPAREN) {
      if (tokens[i].match === undefined) return null;
      i = tokens[i].match + 1;
    }
    if (!isWord(tokens[i], "AS")) return null;
    i++;
    let notMaterialized = false;
    let materialized = false;
    if (isWord(tokens[i], "NOT") && isWord(tokens[i + 1], "MATERIALIZED")) {
      notMaterialized = true;
      i += 2;
    } else if (isWord(tokens[i], "MATERIALIZED")) {
      materialized = true;
      i++;
    }
    const open = tokens[i];
    if (open?.type !== TOKEN.LPAREN || open.match === undefined) return null;
    const close = open.match;
    ctes.push({
      name: nameOf(nameTok),
      nameToken: nameTok.index,
      materialized,
      notMaterialized,
      open: open.index,
      close,
      depth: open.depth,
      limits: [],
    });
    i = close + 1;
    // A recursive CTE's SEARCH and CYCLE clauses sit between its body and the
    // next ',' or the main statement. Their own SET would otherwise end the
    // list at SEARCH and hide the main statement's position.
    i = skipSearchCycle(tokens, i);
    if (tokens[i]?.type === TOKEN.COMMA) {
      i++;
      continue;
    }
    break;
  }
  return { withToken: w, depth: tokens[w].depth, recursive, ctes, mainStatement: i };
}

/** End of a `name [, name …]` list starting at `i`, or -1 when none starts there. */
function nameListEnd(tokens, i) {
  if (!isNameToken(tokens[i])) return -1;
  i++;
  while (tokens[i]?.type === TOKEN.COMMA && isNameToken(tokens[i + 1])) i += 2;
  return i;
}

/** End of one constant `value[::type]` at `i`, or -1. */
function constantEnd(tokens, i) {
  const t = tokens[i];
  if (t === undefined || ![TOKEN.WORD, TOKEN.STRING, TOKEN.NUMBER, TOKEN.PARAM, TOKEN.OPAQUE].includes(t.type)) return -1;
  i++;
  while (tokens[i]?.text === ":" && tokens[i + 1]?.text === ":" && isNameToken(tokens[i + 2])) i += 3;
  return i;
}

/**
 * Skip `SEARCH {BREADTH|DEPTH} FIRST BY cols SET col` and then
 * `CYCLE cols SET col [TO value DEFAULT value] USING col` after a CTE body,
 * each optional. Returns the first token after them; a clause that does not
 * parse is not skipped, so the WITH list ends there as before.
 */
function skipSearchCycle(tokens, i) {
  if (
    isWord(tokens[i], "SEARCH") &&
    (isWord(tokens[i + 1], "BREADTH") || isWord(tokens[i + 1], "DEPTH")) &&
    isWord(tokens[i + 2], "FIRST") &&
    isWord(tokens[i + 3], "BY")
  ) {
    const cols = nameListEnd(tokens, i + 4);
    if (cols !== -1 && isWord(tokens[cols], "SET") && isNameToken(tokens[cols + 1])) i = cols + 2;
  }
  if (isWord(tokens[i], "CYCLE")) {
    const cols = nameListEnd(tokens, i + 1);
    if (cols !== -1 && isWord(tokens[cols], "SET") && isNameToken(tokens[cols + 1])) {
      let j = cols + 2;
      if (isWord(tokens[j], "TO")) {
        const to = constantEnd(tokens, j + 1);
        if (to === -1 || !isWord(tokens[to], "DEFAULT")) return i;
        j = constantEnd(tokens, to + 1);
        if (j === -1) return i;
      }
      if (isWord(tokens[j], "USING") && isNameToken(tokens[j + 1])) i = j + 2;
    }
  }
  return i;
}

/**
 * Tokens of the target table after `UPDATE` / `DELETE FROM`:
 * `[ONLY] name[.name…] [*] [[AS] alias]`. Returns `{ end, target }` where
 * `end` is the first token after the target clause, or null when the shape
 * does not parse.
 */
function parseTarget(tokens, i) {
  if (isWord(tokens[i], "ONLY")) i++;
  if (!isNameToken(tokens[i])) return null;
  const nameTokens = [i];
  i++;
  while (tokens[i]?.type === TOKEN.DOT && isNameToken(tokens[i + 1])) {
    nameTokens.push(i + 1);
    i += 2;
  }
  if (tokens[i]?.type === TOKEN.OP && tokens[i].text === "*") i++;
  const last = tokens[nameTokens[nameTokens.length - 1]];
  const target = {
    name: last.type === TOKEN.OPAQUE ? null : nameOf(last),
    opaque: last.type === TOKEN.OPAQUE ? last.text : null,
    tokens: nameTokens,
  };
  return { end: i, target };
}

export const WRITE_KIND = Object.freeze({
  DELETE: "DELETE",
  UPDATE: "UPDATE",
  MERGE: "MERGE",
  UPSERT: "UPSERT",
});

/** First index in [from, end) of a WORD `upper` at `depth`, or -1. */
function findWordAt(tokens, from, end, depth, upper) {
  for (let j = from; j < end; j++) if (tokens[j].depth === depth && isWord(tokens[j], upper)) return j;
  return -1;
}

/** `[[AS] alias]` after a target ending at `end`; `stop` says which word is not an alias. */
function skipAlias(tokens, end, stop) {
  if (isWord(tokens[end], "AS") && isNameToken(tokens[end + 1])) return end + 2;
  if (tokens[end]?.type === TOKEN.WORD && !stop(tokens[end])) return end + 1;
  return end;
}

/**
 * First WORD `upper` in [from, end) at `depth` that is not inside a
 * `CASE … END` expression at that depth (nested CASEs counted), or -1 when
 * there is none. Returns null when the range holds an END with no CASE or a
 * CASE whose END never comes: the caller cannot tell clause words from
 * expression words then.
 */
function clauseWordAt(tokens, from, end, depth, upper) {
  let openCase = 0;
  for (let j = from; j < end; j++) {
    const t = tokens[j];
    if (t.depth !== depth) continue;
    // After `.` or `AS` PostgreSQL accepts a reserved word as a column name or
    // label (`p.end`, `u.case`, `RETURNING id AS end`): not a keyword here.
    const prev = tokens[j - 1];
    if (prev !== undefined && (prev.type === TOKEN.DOT || isWord(prev, "AS"))) continue;
    if (isWord(t, "CASE")) openCase++;
    else if (isWord(t, "END")) {
      if (openCase === 0) return null;
      openCase--;
    } else if (openCase === 0 && isWord(t, upper)) return j;
  }
  return openCase === 0 ? -1 : null;
}

/**
 * The WHEN clauses of a MERGE between `from` and the statement end, at the
 * MERGE's depth: `WHEN [NOT] MATCHED [BY SOURCE|TARGET] [AND …] THEN
 * <action>`. A `CASE … WHEN … THEN … END` expression at that depth (in the ON
 * condition, a WHEN condition or an action's SET) is skipped, so only clause
 * WHEN / THEN are read. Returns the action tokens, each `{ token, action }`
 * with action UPDATE (followed by SET), DELETE, INSERT, NOTHING
 * (`DO NOTHING`) or null when unreadable; or null when a CASE is unbalanced.
 */
function mergeActions(tokens, from, end, depth) {
  const out = [];
  let j = from;
  for (;;) {
    const when = clauseWordAt(tokens, j, end, depth, "WHEN");
    if (when === null) return null;
    if (when === -1) return out;
    const then = clauseWordAt(tokens, when + 1, end, depth, "THEN");
    if (then === null) return null;
    if (then === -1) {
      out.push({ token: when, action: null });
      return out;
    }
    const a = tokens[then + 1];
    let action = null;
    if (isWord(a, "UPDATE") && isWord(tokens[then + 2], "SET")) action = "UPDATE";
    else if (isWord(a, "DELETE")) action = "DELETE";
    else if (isWord(a, "INSERT")) action = "INSERT";
    else if (isWord(a, "DO") && isWord(tokens[then + 2], "NOTHING")) action = "NOTHING";
    out.push({ token: then + 1, action });
    j = then + 1;
  }
}

/**
 * Statement-position write, checked against the statement's own grammar:
 *   - `DELETE FROM <target>`;
 *   - `UPDATE <target> [[AS] alias] SET`;
 *   - `MERGE INTO <target> [[AS] alias] USING … WHEN … THEN UPDATE|DELETE`
 *     (at least one UPDATE or DELETE action);
 *   - `INSERT INTO <target> … ON CONFLICT … DO UPDATE SET` (an upsert).
 * So `FOR UPDATE`, `ON DELETE CASCADE`, a `DO UPDATE SET` with no INSERT head
 * and prose such as "Update your profile" are not writes here (analyzeSql
 * decides separately whether such a word is a known non-write).
 *
 * Returns `{ kind, target, headEnd, consumed }` — `consumed` lists the
 * UPDATE/DELETE/MERGE word tokens this write accounts for — or
 * `{ kind: null, consumed }` for a MERGE whose actions are only INSERT or
 * DO NOTHING (a known non-write), or null.
 */
function parseWriteHead(tokens, i, end) {
  const t = tokens[i];
  if (isWord(t, "DELETE")) {
    if (!isWord(tokens[i + 1], "FROM")) return null;
    const parsed = parseTarget(tokens, i + 2);
    if (!parsed) return null;
    const headEnd = skipAlias(tokens, parsed.end, isClauseWord);
    return { kind: WRITE_KIND.DELETE, target: parsed.target, headEnd, consumed: [i] };
  }
  if (isWord(t, "UPDATE")) {
    const parsed = parseTarget(tokens, i + 1);
    if (!parsed) return null;
    const headEnd = skipAlias(tokens, parsed.end, (w) => isWord(w, "SET"));
    if (!isWord(tokens[headEnd], "SET")) return null;
    return { kind: WRITE_KIND.UPDATE, target: parsed.target, headEnd, consumed: [i] };
  }
  if (isWord(t, "MERGE")) {
    if (!isWord(tokens[i + 1], "INTO")) return null;
    const parsed = parseTarget(tokens, i + 2);
    if (!parsed) return null;
    const headEnd = skipAlias(tokens, parsed.end, (w) => isWord(w, "USING"));
    if (!isWord(tokens[headEnd], "USING")) return null;
    const actions = mergeActions(tokens, headEnd, end, t.depth);
    if (actions === null || actions.length === 0 || actions.some((a) => a.action === null)) return null;
    const writing = actions.filter((a) => a.action === "UPDATE" || a.action === "DELETE");
    const consumed = [i, ...writing.map((a) => a.token)];
    if (writing.length === 0) return { kind: null, consumed };
    return { kind: WRITE_KIND.MERGE, target: parsed.target, headEnd, consumed };
  }
  if (isWord(t, "INSERT")) {
    if (!isWord(tokens[i + 1], "INTO")) return null;
    const parsed = parseTarget(tokens, i + 2);
    if (!parsed) return null;
    for (let j = parsed.end; j < end; j++) {
      if (tokens[j].depth !== t.depth || !isWord(tokens[j], "ON") || !isWord(tokens[j + 1], "CONFLICT")) continue;
      const doAt = findWordAt(tokens, j + 2, end, t.depth, "DO");
      if (doAt !== -1 && isWord(tokens[doAt + 1], "UPDATE") && isWord(tokens[doAt + 2], "SET")) {
        return { kind: WRITE_KIND.UPSERT, target: parsed.target, headEnd: parsed.end, consumed: [doAt + 1] };
      }
      return null;
    }
    return null;
  }
  return null;
}

const WRITE_WORDS = new Set(["UPDATE", "DELETE", "MERGE"]);

/**
 * An UPDATE/DELETE word that is not a statement by grammar: the row-lock
 * clause `FOR UPDATE` / `FOR NO KEY UPDATE`, and a referential action or rule
 * event `ON UPDATE` / `ON DELETE`.
 */
function isKnownNonWrite(tokens, k) {
  const t = tokens[k];
  const prev = tokens[k - 1];
  if (t.upper === "UPDATE") {
    if (isWord(prev, "FOR")) return true;
    if (isWord(prev, "KEY") && isWord(tokens[k - 2], "NO") && isWord(tokens[k - 3], "FOR")) return true;
  }
  if ((t.upper === "UPDATE" || t.upper === "DELETE") && isWord(prev, "ON")) return true;
  return false;
}

const CLAUSE_WORDS = new Set(["WHERE", "USING", "RETURNING", "SET", "FROM"]);
const isClauseWord = (t) => t?.type === TOKEN.WORD && CLAUSE_WORDS.has(t.upper);

/** First token index after `from` that ends the statement which begins at depth `depth`. */
function statementEnd(tokens, from, depth) {
  for (let j = from; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === TOKEN.SEMI && t.depth <= depth) return j;
    if (t.type === TOKEN.RPAREN && t.depth < depth) return j;
  }
  return tokens.length;
}

/**
 * @typedef {{ inToken: number, negated: boolean, lhs: { start: number, end: number },
 *   open: number, close: number | undefined, depth: number }} InGroup
 * @typedef {{ start: number, end: number, hasOr: boolean, negated: boolean,
 *   inGroup: InGroup | null }} Conjunct
 */

/**
 * Split [start, end) at top-level (depth `depth`) AND. A top-level OR makes
 * the whole range one conjunct flagged `hasOr` (AND binds tighter than OR, so
 * no AND operand is then a conjunct of the whole WHERE). The AND of a
 * `BETWEEN x AND y` is not a separator. `inGroup` starts null; analyzeSql
 * links it.
 *
 * @returns {Conjunct[]}
 */
function splitConjuncts(tokens, start, end, depth) {
  const conjunct = (s, e, hasOr) => ({ start: s, end: e, hasOr, negated: isWord(tokens[s], "NOT"), inGroup: null });
  const top = [];
  for (let j = start; j < end; j++) if (tokens[j].depth === depth) top.push(j);
  const hasOr = top.some((j) => isWord(tokens[j], "OR"));
  if (hasOr) return [conjunct(start, end, true)];
  const out = [];
  let s = start;
  let pendingBetween = false;
  for (const j of top) {
    if (isWord(tokens[j], "BETWEEN")) pendingBetween = true;
    else if (isWord(tokens[j], "AND")) {
      if (pendingBetween) {
        pendingBetween = false;
        continue;
      }
      out.push(conjunct(s, j, false));
      s = j + 1;
    }
  }
  out.push(conjunct(s, end, false));
  return out.filter((c) => c.end > c.start);
}

/**
 * Every `IN (` group: `{ inToken, negated, lhs: {start, end}, open, close, depth }`.
 * The left operand is a parenthesised group ending right before IN (row
 * value), or a dotted name chain. `close` is undefined when unbalanced.
 *
 * @returns {InGroup[]}
 */
function findInGroups(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "IN") || tokens[i + 1]?.type !== TOKEN.LPAREN) continue;
    let k = i - 1;
    let negated = false;
    if (isWord(tokens[k], "NOT")) {
      negated = true;
      k--;
    }
    let lhsStart = k;
    if (tokens[k]?.type === TOKEN.RPAREN && tokens[k].match !== undefined) {
      lhsStart = tokens[k].match;
    } else {
      while (
        isNameToken(tokens[lhsStart]) &&
        tokens[lhsStart - 1]?.type === TOKEN.DOT &&
        isNameToken(tokens[lhsStart - 2])
      ) {
        lhsStart -= 2;
      }
    }
    out.push({
      inToken: i,
      negated,
      lhs: { start: Math.max(lhsStart, 0), end: k + 1 },
      open: i + 1,
      close: tokens[i + 1].match,
      depth: tokens[i].depth,
    });
  }
  return out;
}

/**
 * Analyse one literal. Returns:
 *   - tokens
 *   - withLists: `{ withToken, depth, recursive, ctes, mainStatement }`; each
 *     cte `{ name, nameToken, materialized, notMaterialized, open, close,
 *     depth, limits }` where `limits` are the indexes (into `limits` below)
 *     of the LIMIT/FETCH tokens at the TOP level of the body. `materialized`
 *     is token-exact: `AS NOT MATERIALIZED` sets `notMaterialized` only.
 *   - limits: every `LIMIT` and `FETCH FIRST|NEXT`, as
 *     `{ token, kind: "LIMIT"|"FETCH", depth, line, arg }` (`arg` is the
 *     upper-cased text of the next token, so `ALL` / `NULL` are visible).
 *   - writes: every statement-position write (see parseWriteHead; `${…}`
 *     tokens before the head are transparent), as
 *     `{ kind, token, depth, line, target: {name, opaque, tokens}, end,
 *        withList, cte, where: {start, end} | null, conjuncts }` where `kind`
 *     is a WRITE_KIND, `withList` is the index of the WITH list whose main
 *     statement this is, or whose CTE body holds it (then `cte` is that
 *     CTE's index); conjuncts are `{ start, end, hasOr, negated, inGroup }`
 *     with `inGroup` set when the conjunct is exactly `<lhs> IN ( … )` (never
 *     under a top-level OR or a leading NOT). MERGE and UPSERT have
 *     `where: null` and no conjuncts.
 *   - unrecognisedWrites: every UPDATE / DELETE / MERGE word token, as
 *     `{ token, word, depth, line }`, that no write above accounts for (its
 *     head, a MERGE's WHEN … THEN action, an upsert's DO UPDATE, or a MERGE
 *     whose actions are only INSERT / DO NOTHING) and that is not
 *     `FOR [NO KEY] UPDATE` or `ON UPDATE|DELETE`. Reported in every
 *     literal, prose included; callers fail closed on them, each under its
 *     own condition.
 *   - hasParenGroup: whether the literal holds a `(`. C2 ignores
 *     unrecognisedWrites without one: UPDATE, DELETE and MERGE have no LIMIT
 *     clause, so a LIMIT/FETCH can bound one only through a subquery or a CTE
 *     body, both parenthesised. That reasoning is about a LIMIT's reach, not
 *     about whether the word writes, so INV4 does not apply it.
 *   - inGroups: every `IN (` group (see findInGroups).
 */
export function analyzeSql(input) {
  const tokens = tokenizeSql(input);

  const limits = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isWord(t, "LIMIT")) {
      limits.push({ token: i, kind: "LIMIT", depth: t.depth, line: t.line, arg: tokens[i + 1]?.upper ?? null });
    } else if (isWord(t, "FETCH") && (isWord(tokens[i + 1], "FIRST") || isWord(tokens[i + 1], "NEXT"))) {
      limits.push({ token: i, kind: "FETCH", depth: t.depth, line: t.line, arg: tokens[i + 2]?.upper ?? null });
    }
  }

  const withLists = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "WITH")) continue;
    const list = parseWithList(tokens, i);
    if (list) withLists.push(list);
  }
  for (const list of withLists) {
    for (const cte of list.ctes) {
      cte.limits = limits
        .map((l, idx) => ({ l, idx }))
        .filter(({ l }) => l.token > cte.open && l.token < cte.close && l.depth === cte.depth + 1)
        .map(({ idx }) => idx);
    }
  }

  // Statement positions: literal start, after `;`, a CTE body start, and the
  // main statement after a WITH list.
  const positions = new Map(); // token index -> { withList, cte }
  if (tokens.length > 0) positions.set(0, { withList: null, cte: null });
  tokens.forEach((t, i) => {
    if (t.type === TOKEN.SEMI && i + 1 < tokens.length) positions.set(i + 1, { withList: null, cte: null });
  });
  withLists.forEach((list, li) => {
    list.ctes.forEach((cte, ci) => positions.set(cte.open + 1, { withList: li, cte: ci }));
    if (list.mainStatement < tokens.length) positions.set(list.mainStatement, { withList: li, cte: null });
  });

  const inGroups = findInGroups(tokens);
  const inByLhsStart = new Map();
  for (const g of inGroups) inByLhsStart.set(`${g.lhs.start}:${g.close}`, g);

  const writes = [];
  const accounted = new Set(); // UPDATE/DELETE/MERGE word tokens a parsed statement explains
  for (const [position, ctx] of [...positions.entries()].sort((a, b) => a[0] - b[0])) {
    // A `${…}` substitution before the head (a hint, a fragment) is
    // transparent: the write after it is still at statement position.
    let i = position;
    while (tokens[i]?.type === TOKEN.OPAQUE) i++;
    if (i >= tokens.length) continue;
    const depth = tokens[i].depth;
    const end = statementEnd(tokens, i + 1, depth);
    const head = parseWriteHead(tokens, i, end);
    if (!head) continue;
    for (const k of head.consumed) accounted.add(k);
    if (head.kind === null) continue;
    let where = null;
    const hasWhere = head.kind === WRITE_KIND.DELETE || head.kind === WRITE_KIND.UPDATE;
    for (let j = head.headEnd; hasWhere && j < end; j++) {
      if (isWord(tokens[j], "WHERE") && tokens[j].depth === depth) {
        let whereEnd = end;
        for (let k = j + 1; k < end; k++) {
          if (isWord(tokens[k], "RETURNING") && tokens[k].depth === depth) {
            whereEnd = k;
            break;
          }
        }
        where = { start: j + 1, end: whereEnd };
        break;
      }
    }
    const conjuncts = where ? splitConjuncts(tokens, where.start, where.end, depth) : [];
    for (const c of conjuncts) {
      if (c.hasOr || c.negated) continue;
      const g = inByLhsStart.get(`${c.start}:${c.end - 1}`);
      if (g && !g.negated) c.inGroup = g;
    }
    writes.push({
      kind: head.kind,
      token: i,
      depth,
      line: tokens[i].line,
      target: head.target,
      end,
      withList: ctx.withList,
      cte: ctx.cte,
      where,
      conjuncts,
    });
  }

  // Reported whether or not the literal is prose: which callers may ignore a
  // word, and on what condition, is each caller's own question (C2 asks it
  // through hasParenGroup; INV4 never ignores one).
  const unrecognisedWrites = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== TOKEN.WORD || !WRITE_WORDS.has(t.upper)) continue;
    if (accounted.has(k) || isKnownNonWrite(tokens, k)) continue;
    unrecognisedWrites.push({ token: k, word: t.upper, depth: t.depth, line: t.line });
  }
  const hasParenGroup = tokens.some((t) => t.type === TOKEN.LPAREN);

  return { tokens, limits, withLists, writes, unrecognisedWrites, hasParenGroup, inGroups };
}

/**
 * Key list of a range: `a`, `"a"`, `(a, b)`, `(${keys})` → normalised names,
 * or null when any element is not a single name token.
 */
export function keyListOf(analysis, start, end) {
  const { tokens } = analysis;
  let s = start;
  let e = end;
  if (tokens[s]?.type === TOKEN.LPAREN && tokens[s].match === e - 1) {
    s++;
    e--;
  }
  if (e <= s) return null;
  const out = [];
  let expectName = true;
  for (let j = s; j < e; j++) {
    const t = tokens[j];
    if (expectName) {
      if (!isNameToken(t)) return null;
      out.push(nameOf(t));
      expectName = false;
    } else {
      if (t.type !== TOKEN.COMMA) return null;
      expectName = true;
    }
  }
  return expectName ? null : out;
}

/**
 * The body of a paren group `open … close` when it is EXACTLY
 * `SELECT <keys> FROM <name>` — no WHERE, set operation, join, second FROM
 * item, alias or trailing clause. Returns `{ keys, from }` or null.
 */
export function matchKeySelect(analysis, open, close) {
  const { tokens } = analysis;
  if (close === undefined) return null;
  const s = open + 1;
  if (!isWord(tokens[s], "SELECT")) return null;
  let fromAt = -1;
  for (let j = s + 1; j < close; j++) {
    if (isWord(tokens[j], "FROM") && tokens[j].depth === tokens[open].depth + 1) {
      fromAt = j;
      break;
    }
  }
  if (fromAt === -1) return null;
  const keys = keyListOf(analysis, s + 1, fromAt);
  if (keys === null) return null;
  if (fromAt + 2 !== close || !isNameToken(tokens[fromAt + 1])) return null;
  return { keys, from: nameOf(tokens[fromAt + 1]) };
}
