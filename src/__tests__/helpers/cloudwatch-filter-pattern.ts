/**
 * Whether a JSON log line matches a CloudWatch Logs metric-filter pattern of
 * the forms infra/terraform/monitoring.tf uses: `$.key <op> value` terms
 * (string or number), `$.key IS TRUE|FALSE|NULL`, joined by `&&` / `||` and
 * grouped by parentheses. Anything else throws, so an unsupported pattern
 * fails a test loudly rather than reading as "no match".
 *
 * CloudWatch compares a string term only against a string field and a numeric
 * term only against a number; a missing field matches nothing, `!=` included.
 */
export function matchesFilterPattern(pattern: string, line: Record<string, unknown>): boolean {
  const body = /^\{\s*(.*?)\s*\}$/.exec(pattern)?.[1];
  if (body === undefined) throw new Error(`unsupported pattern: ${pattern}`);
  const tokens =
    body.match(/\(|\)|&&|\|\||\$\.\w+\s+IS\s+(?:TRUE|FALSE|NULL)|\$\.\w+\s*(?:=|!=|>=|<=|>|<)\s*(?:"[^"]*"|-?\d+(?:\.\d+)?)/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== body.replace(/\s/g, "")) throw new Error(`unsupported pattern: ${pattern}`);
  let i = 0;
  const term = (t: string): boolean => {
    const is = /^\$\.(\w+)\s+IS\s+(TRUE|FALSE|NULL)$/.exec(t);
    if (is) {
      const actual = line[is[1]];
      return is[2] === "NULL" ? actual === null : actual === (is[2] === "TRUE");
    }
    const m = /^\$\.(\w+)\s*(=|!=|>=|<=|>|<)\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?))$/.exec(t);
    if (!m) throw new Error(`unsupported term: ${t}`);
    const [, key, op, str, num] = m;
    const actual = line[key];
    if (str !== undefined) {
      if (typeof actual !== "string") return false;
      return op === "=" ? actual === str : op === "!=" ? actual !== str : false;
    }
    if (typeof actual !== "number") return false;
    const n = Number(num);
    return { "=": actual === n, "!=": actual !== n, ">=": actual >= n, "<=": actual <= n, ">": actual > n, "<": actual < n }[op] as boolean;
  };
  const primary = (): boolean => {
    const t = tokens[i++];
    if (t === "(") {
      const v = or();
      if (tokens[i++] !== ")") throw new Error(`unbalanced pattern: ${pattern}`);
      return v;
    }
    if (t === undefined || t === ")" || t === "&&" || t === "||") throw new Error(`malformed pattern: ${pattern}`);
    return term(t);
  };
  const and = (): boolean => {
    let v = primary();
    while (tokens[i] === "&&") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  function or(): boolean {
    let v = and();
    while (tokens[i] === "||") {
      i++;
      v = and() || v;
    }
    return v;
  }
  const result = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in pattern: ${pattern}`);
  return result;
}
