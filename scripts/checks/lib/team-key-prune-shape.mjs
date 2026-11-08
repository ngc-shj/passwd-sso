/**
 * Body shape of team_member_key_prune (#1009), shared by the C2 gate
 * (scripts/checks/check-team-key-version-refs.mjs, over the latest defining
 * migration) and the prune integration test (over pg_get_functiondef on the
 * live database).
 *
 * The prune's safety rests on its order of statements, not only on its
 * predicates: it must lock the teams it considers (`teams ... FOR NO KEY
 * UPDATE ... SKIP LOCKED`) in one statement and decide and delete in a LATER
 * statement, restricted to the locked teams, so the decision reads a snapshot
 * taken with the locks held (every copier of a non-current version holds
 * `teams ... FOR SHARE` for its whole transaction). This module checks that
 * order over the PL/pgSQL body:
 *
 *   - the first statement is the RLS-bypass check
 *     `IF NOT (SELECT [public.]rls_bypass_admits('team_member_keys')) THEN RAISE ... '42501'`;
 *   - every other guard is `IF <condition> THEN RAISE ...` / `END IF` whose
 *     condition reads no table (no SELECT or other statement keyword), and one
 *     of them refuses unless `current_setting('transaction_isolation')` is
 *     `'read committed'` (a later statement gets a new snapshot only there);
 *   - exactly one `SELECT ... INTO <var>` statement, which locks `teams`
 *     through `FOR NO KEY UPDATE OF <alias> SKIP LOCKED` (alias bound to teams);
 *   - exactly one `RETURN QUERY`, after it and last, naming
 *     `<alias>.team_id = ANY (<var>)`;
 *   - no other statement (PERFORM, EXECUTE, INSERT/UPDATE/DELETE, a second
 *     SELECT, assignment from a query) and no DECLARE initialiser.
 *
 * What it does NOT prove: that `= ANY (<var>)` restricts every branch of the
 * RETURN QUERY (it is required to appear, not to be a top-level conjunct of
 * each read), or that the predicates are right — the integration cells do.
 * It reads text through the shared SQL lexer (sql-scan.mjs), so a keyword in
 * a comment or a string literal is not a keyword.
 */
import { TOKEN, tokenizeSql } from "./sql-scan.mjs";

export const PRUNE_FUNCTION = "team_member_key_prune";

/** Words that start (or smuggle in) a statement that reads or writes. */
const STATEMENT_WORDS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "PERFORM", "EXECUTE", "WITH", "COPY", "CALL", "TRUNCATE",
  "LOCK", "VALUES", "TABLE", "FETCH", "OPEN", "MOVE", "FOR", "LOOP", "WHILE", "FOREACH",
]);

const word = (t, upper) => t !== undefined && t.type === TOKEN.WORD && t.upper === upper;
const render = (tokens) => tokens.map((t) => t.text).join(" ");

/**
 * The dollar-quoted body following `CREATE [OR REPLACE] FUNCTION ... team_member_key_prune`
 * in `sql` (a migration, or pg_get_functiondef's output). Returns
 * `{ body }` or `{ error }`; `{ missing: true }` when `sql` does not define it.
 */
export function pruneFunctionBody(sql) {
  const createRe = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?${PRUNE_FUNCTION}\b`, "i");
  const match = createRe.exec(sql);
  if (!match) return { missing: true };
  const rest = sql.slice(match.index);
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest);
  if (!open) return { error: `cannot find the dollar-quoted body of ${PRUNE_FUNCTION}.` };
  const bodyStart = open.index + open[0].length;
  const bodyEnd = rest.indexOf(open[1], bodyStart);
  if (bodyEnd < 0) return { error: `the body of ${PRUNE_FUNCTION} is not closed by ${open[1]}.` };
  return { body: rest.slice(bodyStart, bodyEnd) };
}

/** Split depth-0 tokens at `;` into statements (empty ones dropped). */
function splitStatements(tokens) {
  const out = [];
  let cur = [];
  for (const t of tokens) {
    if (t.type === TOKEN.SEMI && t.depth === 0) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const hasStatementWord = (tokens) => tokens.some((t) => t.type === TOKEN.WORD && STATEMENT_WORDS.has(t.upper));

/** `IF NOT (SELECT [public.]rls_bypass_admits('team_member_keys')) THEN RAISE ... ERRCODE = '42501'`. */
function isBypassCheck(st) {
  const text = render(st);
  return /^IF NOT \( SELECT (?:public \. )?rls_bypass_admits \( 'team_member_keys' \) \) THEN RAISE EXCEPTION\b/i.test(text)
    && /\bERRCODE = '42501'$/i.test(text);
}

/** `IF <cond> THEN RAISE ...`: returns the condition tokens, or null when not that form. */
function guardCondition(st) {
  if (!word(st[0], "IF")) return null;
  const then = st.findIndex((t) => t.depth === 0 && word(t, "THEN"));
  if (then < 0 || !word(st[then + 1], "RAISE")) return null;
  if (hasStatementWord(st.slice(then + 1))) return null;
  return st.slice(1, then);
}

function isIsolationGuard(cond) {
  return /^current_setting \( 'transaction_isolation' \) <> 'read committed'$/i.test(render(cond).replace(/< >/g, "<>"));
}

/** Aliases bound to `teams` by `FROM|JOIN [public.]teams [AS] <alias>`. */
function teamsAliases(st) {
  const out = new Set();
  for (let i = 0; i < st.length; i++) {
    if (!word(st[i], "FROM") && !word(st[i], "JOIN")) continue;
    let j = i + 1;
    if (word(st[j], "PUBLIC") && st[j + 1]?.type === TOKEN.DOT) j += 2;
    if (!word(st[j], "TEAMS")) continue;
    j++;
    if (word(st[j], "AS")) j++;
    if (st[j]?.type === TOKEN.WORD) out.add(st[j].text.toLowerCase());
  }
  return out;
}

/** `FOR NO KEY UPDATE OF <alias> SKIP LOCKED` with the alias bound to teams. */
function locksTeamsSkipLocked(st) {
  const aliases = teamsAliases(st);
  for (let i = 0; i + 7 < st.length; i++) {
    if (
      word(st[i], "FOR") && word(st[i + 1], "NO") && word(st[i + 2], "KEY") && word(st[i + 3], "UPDATE") &&
      word(st[i + 4], "OF") && aliases.has(st[i + 5].text.toLowerCase()) &&
      word(st[i + 6], "SKIP") && word(st[i + 7], "LOCKED")
    ) {
      return true;
    }
  }
  return false;
}

/** The variable of `SELECT ... INTO <var> ...` at depth 0, or null. */
function intoVariable(st) {
  const into = st.findIndex((t) => t.depth === 0 && word(t, "INTO"));
  return into >= 0 && st[into + 1]?.type === TOKEN.WORD ? st[into + 1].text.toLowerCase() : null;
}

/** `<alias> . team_id = ANY ( <var> )` anywhere in the statement. */
function restrictsTo(st, variable) {
  return [...render(st).matchAll(/\b[a-z_][a-z0-9_]* \. team_id = ANY \( ([a-z_][a-z0-9_]*) \)/gi)]
    .some((m) => m[1].toLowerCase() === variable);
}

/**
 * Check the body's statement order. Returns `{ problems, returnQuery }`:
 * `returnQuery` is the RETURN QUERY statement's text (tokens joined by single
 * spaces, comments dropped) when exactly one was found, else null.
 */
export function pruneBodyShape(body) {
  const problems = [];
  let tokens;
  try {
    tokens = tokenizeSql(body);
  } catch (e) {
    return { problems: [`the body of ${PRUNE_FUNCTION} could not be lexed: ${e instanceof Error ? e.message : String(e)}`], returnQuery: null };
  }
  const begin = tokens.findIndex((t) => t.depth === 0 && word(t, "BEGIN"));
  const last = tokens.at(-1)?.type === TOKEN.SEMI ? tokens.length - 2 : tokens.length - 1;
  if (begin < 0 || !word(tokens[last], "END")) {
    return { problems: [`cannot locate the BEGIN ... END block of ${PRUNE_FUNCTION}.`], returnQuery: null };
  }
  const declare = tokens.slice(0, begin);
  if (declare.length > 0 && (!word(declare[0], "DECLARE") || hasStatementWord(declare) || declare.some((t) => word(t, "DEFAULT") || t.text === ":"))) {
    problems.push(`the DECLARE section of ${PRUNE_FUNCTION} may only declare variables, without initialisers.`);
  }
  const statements = splitStatements(tokens.slice(begin + 1, last));
  if (statements.length === 0) {
    return { problems: [`cannot locate any statement in the body of ${PRUNE_FUNCTION}.`], returnQuery: null };
  }

  if (!isBypassCheck(statements[0])) {
    problems.push(`the first statement of ${PRUNE_FUNCTION} must be the RLS-bypass check (IF NOT (SELECT rls_bypass_admits('team_member_keys')) THEN RAISE ... '42501').`);
  }

  let lockAt = -1;
  let lockVar = null;
  let returnAt = -1;
  let isolationAt = -1;
  let locks = 0;
  let returns = 0;
  statements.forEach((st, i) => {
    if (i === 0 && isBypassCheck(st)) return;
    if (word(st[0], "END") && word(st[1], "IF") && st.length === 2) return;
    if (word(st[0], "RETURN") && word(st[1], "QUERY")) {
      returns++;
      returnAt = i;
      if (word(st[2], "EXECUTE")) problems.push(`${PRUNE_FUNCTION}'s RETURN QUERY must not be dynamic (EXECUTE).`);
      return;
    }
    if (word(st[0], "SELECT")) {
      locks++;
      lockAt = i;
      lockVar = intoVariable(st);
      if (!lockVar) problems.push(`${PRUNE_FUNCTION}'s team-lock statement must be SELECT ... INTO <variable>.`);
      if (!locksTeamsSkipLocked(st)) {
        problems.push(`${PRUNE_FUNCTION}'s team-lock statement must lock teams with FOR NO KEY UPDATE OF <teams alias> SKIP LOCKED.`);
      }
      return;
    }
    const cond = guardCondition(st);
    if (cond) {
      if (hasStatementWord(cond)) {
        problems.push(`a guard of ${PRUNE_FUNCTION} reads a table in its condition (only the first, bypass, check may): ${render(st).slice(0, 80)}`);
      }
      if (isIsolationGuard(cond)) isolationAt = i;
      return;
    }
    problems.push(`unexpected statement in ${PRUNE_FUNCTION} (only guards, one team-lock SELECT and one RETURN QUERY are allowed): ${render(st).slice(0, 80)}`);
  });

  if (locks !== 1) problems.push(`${PRUNE_FUNCTION} must have exactly one team-lock statement (SELECT ... INTO), found ${locks}.`);
  if (returns !== 1) problems.push(`${PRUNE_FUNCTION} must have exactly one RETURN QUERY, found ${returns}.`);
  if (isolationAt < 0 || (lockAt >= 0 && isolationAt > lockAt)) {
    problems.push(`${PRUNE_FUNCTION} must refuse unless current_setting('transaction_isolation') is 'read committed' (IF ... <> 'read committed' THEN RAISE), before the team lock.`);
  }
  if (locks === 1 && returns === 1) {
    if (lockAt > returnAt) problems.push(`${PRUNE_FUNCTION}'s team-lock statement must precede its RETURN QUERY.`);
    if (returnAt !== statements.length - 1) problems.push(`${PRUNE_FUNCTION}'s RETURN QUERY must be its last statement.`);
    if (lockVar && !restrictsTo(statements[returnAt], lockVar)) {
      problems.push(`${PRUNE_FUNCTION}'s RETURN QUERY must restrict to the locked teams (<alias>.team_id = ANY (${lockVar})).`);
    }
  }
  return { problems, returnQuery: returns === 1 ? render(statements[returnAt]) : null };
}
