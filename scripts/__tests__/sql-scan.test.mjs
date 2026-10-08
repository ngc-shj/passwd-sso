/**
 * Unit tests for scripts/checks/lib/sql-scan.mjs — the lexical SQL scanner
 * shared by check-limited-subquery-write.mjs (C2) and the sweepBounds guard
 * in src/__tests__/workers/worker-policy-manifest.test.ts (C4).
 */
import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import {
  TOKEN,
  analyzeSql,
  keyListOf,
  matchKeySelect,
  sqlInputFromNode,
  sqlInputFromSourceText,
  tokenizeSql,
} from "../checks/lib/sql-scan.mjs";

const words = (input) => tokenizeSql(input).filter((t) => t.type === TOKEN.WORD).map((t) => t.upper);

describe("tokenizeSql — what is not a keyword", () => {
  it("skips -- line comments", () => {
    expect(words("SELECT 1 -- LIMIT 2\nFROM t")).toEqual(["SELECT", "FROM", "T"]);
  });

  it("skips nested /* */ block comments", () => {
    expect(words("SELECT /* a /* LIMIT */ still comment LIMIT */ 1")).toEqual(["SELECT"]);
  });

  it("reads '…' with '' escapes as one string token", () => {
    const toks = tokenizeSql("SELECT 'it''s LIMIT 1' AS x");
    expect(toks.map((t) => t.type)).toEqual([TOKEN.WORD, TOKEN.STRING, TOKEN.WORD, TOKEN.WORD]);
    expect(toks[1].text).toBe("'it''s LIMIT 1'");
  });

  it("reads E'…' with backslash escapes as one string token", () => {
    expect(words("SELECT E'a\\' LIMIT 1' FROM t")).toEqual(["SELECT", "FROM", "T"]);
  });

  it("does not read a word ending in E as an escape-string prefix", () => {
    const toks = tokenizeSql("SELECT type'x'");
    expect(toks.map((t) => t.type)).toEqual([TOKEN.WORD, TOKEN.WORD, TOKEN.STRING]);
  });

  it("reads $$…$$ and $tag$…$tag$ as string tokens", () => {
    expect(words("SELECT $$ LIMIT 1 $$, $fn$ DELETE FROM t $fn$ FROM t")).toEqual(["SELECT", "FROM", "T"]);
  });

  it("reads $n as a parameter, not a dollar quote", () => {
    const toks = tokenizeSql("LIMIT $1");
    expect(toks[1]).toMatchObject({ type: TOKEN.PARAM, text: "$1" });
  });

  it("reads \"…\" with \"\" escapes as a quoted identifier with its unquoted value", () => {
    const toks = tokenizeSql('SELECT "LIMIT", "a""b" FROM t');
    expect(toks.filter((t) => t.type === TOKEN.QIDENT).map((t) => t.value)).toEqual(["LIMIT", 'a"b']);
    expect(words('SELECT "LIMIT" FROM t')).toEqual(["SELECT", "FROM", "T"]);
  });

  it("treats each substitution as one opaque token and never looks inside it", () => {
    const toks = tokenizeSql({ parts: ["DELETE FROM ", " WHERE x"], substitutions: ["`LIMIT 1`"] });
    expect(toks.map((t) => t.type)).toEqual([TOKEN.WORD, TOKEN.WORD, TOKEN.OPAQUE, TOKEN.WORD, TOKEN.WORD]);
    expect(toks[2]).toMatchObject({ text: "`LIMIT 1`", value: "${`LIMIT 1`}" });
  });

  it("lexes a literal U+E000 character as an operator, not a substitution", () => {
    const toks = tokenizeSql("SELECT  FROM t");
    expect(toks[1].type).toBe(TOKEN.OP);
  });
});

describe("tokenizeSql — depth and lines", () => {
  it("gives matching parens the outer depth and links them", () => {
    const toks = tokenizeSql("a (b (c) d) e");
    expect(toks.map((t) => [t.text, t.depth])).toEqual([
      ["a", 0], ["(", 0], ["b", 1], ["(", 1], ["c", 2], [")", 1], ["d", 1], [")", 0], ["e", 0],
    ]);
    expect(toks[1].match).toBe(7);
    expect(toks[7].match).toBe(1);
  });

  it("tolerates unbalanced fragments", () => {
    const toks = tokenizeSql("LIMIT $1)");
    expect(toks[2]).toMatchObject({ type: TOKEN.RPAREN, depth: -1 });
    expect(toks[2].match).toBeUndefined();
  });

  it("counts lines across text, comments and substitution source", () => {
    const toks = tokenizeSql({ parts: ["a\n-- c\nb ", "\nd"], substitutions: ["x\ny"] });
    expect(toks.map((t) => [t.text, t.line])).toEqual([["a", 0], ["b", 2], ["x\ny", 2], ["d", 4]]);
  });
});

describe("analyzeSql — write statements", () => {
  it("finds a write at the literal start", () => {
    expect(analyzeSql("DELETE FROM t WHERE id = 1").writes.map((w) => w.kind)).toEqual(["DELETE"]);
  });

  it("finds a lowercase write", () => {
    expect(analyzeSql("update t set a = 1").writes.map((w) => w.kind)).toEqual(["UPDATE"]);
  });

  it("finds a write after ;", () => {
    expect(analyzeSql("SELECT 1; UPDATE t SET a = 1").writes.map((w) => w.kind)).toEqual(["UPDATE"]);
  });

  it("finds a write at the start of a CTE body and links it to that CTE", () => {
    const a = analyzeSql("WITH deleted AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT count(*) FROM deleted");
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toMatchObject({ kind: "DELETE", depth: 1, withList: 0, cte: 0 });
  });

  it("finds the main statement after a WITH list", () => {
    const a = analyzeSql("WITH p AS MATERIALIZED (SELECT id FROM t LIMIT 1) DELETE FROM t WHERE id IN (SELECT id FROM p)");
    expect(a.writes[0]).toMatchObject({ kind: "DELETE", depth: 0, withList: 0, cte: null });
  });

  it("does not count FOR UPDATE / FOR NO KEY UPDATE", () => {
    expect(analyzeSql("SELECT id FROM t LIMIT 1 FOR UPDATE SKIP LOCKED").writes).toEqual([]);
    expect(analyzeSql("SELECT id FROM t LIMIT 1 FOR NO KEY UPDATE").writes).toEqual([]);
  });

  it("does not count UPDATE/DELETE outside statement position", () => {
    expect(analyzeSql("INSERT INTO t SELECT * FROM u ON CONFLICT (id) DO UPDATE SET a = 1").writes).toEqual([]);
    expect(analyzeSql("ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u ON DELETE CASCADE").writes).toEqual([]);
  });

  it("does not count prose that only starts with the keyword", () => {
    expect(analyzeSql("Update your profile to raise the limit").writes).toEqual([]);
    expect(analyzeSql("Delete failed: limit exceeded").writes).toEqual([]);
  });

  it("reads the target table: quoted, schema-qualified, ONLY, aliased, opaque", () => {
    expect(analyzeSql('UPDATE "audit_deliveries" SET a = 1').writes[0].target.name).toBe("audit_deliveries");
    expect(analyzeSql("UPDATE public.Foo f SET a = 1").writes[0].target.name).toBe("foo");
    expect(analyzeSql("DELETE FROM ONLY t AS x WHERE true").writes[0].target.name).toBe("t");
    const opaque = analyzeSql(sqlInputFromSourceText("DELETE FROM ${tableIdent} WHERE true")).writes[0].target;
    expect(opaque).toMatchObject({ name: null, opaque: "tableIdent" });
  });

  it("does not read SKIP from FOR UPDATE SKIP LOCKED as the target", () => {
    const a = analyzeSql(
      "WITH p AS MATERIALIZED (SELECT tenant_id FROM audit_chain_anchors LIMIT 1 FOR UPDATE SKIP LOCKED) " +
        "UPDATE audit_chain_anchors SET a = 1 WHERE (tenant_id) IN (SELECT tenant_id FROM p)",
    );
    expect(a.writes.map((w) => w.target.name)).toEqual(["audit_chain_anchors"]);
  });
});

describe("analyzeSql — WITH lists", () => {
  it("records name, MATERIALIZED flag, body span and top-level LIMITs", () => {
    const a = analyzeSql("WITH picked AS MATERIALIZED (SELECT id FROM t ORDER BY id LIMIT $1) DELETE FROM t");
    expect(a.withLists).toHaveLength(1);
    const [cte] = a.withLists[0].ctes;
    expect(cte).toMatchObject({ name: "picked", materialized: true, notMaterialized: false, depth: 0 });
    expect(a.tokens[cte.open].text).toBe("(");
    expect(a.tokens[cte.close].text).toBe(")");
    expect(cte.limits.map((i) => a.limits[i].arg)).toEqual(["$1"]);
  });

  it("reads AS NOT MATERIALIZED token-exactly: not materialized", () => {
    const [cte] = analyzeSql("WITH p AS NOT MATERIALIZED (SELECT 1 LIMIT 1) SELECT 1").withLists[0].ctes;
    expect(cte).toMatchObject({ materialized: false, notMaterialized: true });
  });

  it("reads a plain CTE as neither", () => {
    const [cte] = analyzeSql("WITH p AS (SELECT 1) SELECT 1").withLists[0].ctes;
    expect(cte).toMatchObject({ materialized: false, notMaterialized: false });
  });

  it("reads several CTEs, RECURSIVE and a column list", () => {
    const list = analyzeSql(
      'WITH RECURSIVE a(x) AS (SELECT 1), "B" AS MATERIALIZED (SELECT 2 LIMIT 1) SELECT 1',
    ).withLists[0];
    expect(list.recursive).toBe(true);
    expect(list.ctes.map((c) => [c.name, c.materialized])).toEqual([["a", false], ["B", true]]);
  });

  it("excludes a LIMIT nested below the body's top level", () => {
    const a = analyzeSql("WITH p AS MATERIALIZED (SELECT id FROM (SELECT id FROM t LIMIT 1) s) SELECT 1");
    expect(a.limits).toHaveLength(1);
    expect(a.withLists[0].ctes[0].limits).toEqual([]);
  });

  it("records a nested WITH list at its own depth", () => {
    const a = analyzeSql("UPDATE t SET a = 1 WHERE id IN (WITH q AS MATERIALIZED (SELECT id FROM t LIMIT 1) SELECT id FROM q)");
    expect(a.withLists.map((l) => l.depth)).toEqual([1]);
  });

  it("is not fooled by WITH TIME ZONE / WITH ORDINALITY / WITH (storage options)", () => {
    expect(analyzeSql("SELECT now()::timestamp WITH TIME ZONE").withLists).toEqual([]);
    expect(analyzeSql("SELECT * FROM unnest(a) WITH ORDINALITY AS u").withLists).toEqual([]);
    expect(analyzeSql("CREATE TABLE t (a int) WITH (fillfactor = 70)").withLists).toEqual([]);
  });
});

describe("analyzeSql — LIMIT / FETCH tokens", () => {
  it("records LIMIT with its argument, so ALL / NULL are visible", () => {
    expect(analyzeSql("SELECT 1 LIMIT ALL").limits[0]).toMatchObject({ kind: "LIMIT", arg: "ALL" });
    expect(analyzeSql("SELECT 1 LIMIT NULL").limits[0]).toMatchObject({ kind: "LIMIT", arg: "NULL" });
  });

  it("records FETCH FIRST and FETCH NEXT", () => {
    expect(analyzeSql("SELECT 1 FETCH FIRST 2 ROWS ONLY").limits[0]).toMatchObject({ kind: "FETCH", arg: "2" });
    expect(analyzeSql("SELECT 1 FETCH NEXT 2 ROWS ONLY").limits[0]).toMatchObject({ kind: "FETCH" });
  });

  it("does not record a cursor FETCH", () => {
    expect(analyzeSql("FETCH 10 FROM c").limits).toEqual([]);
  });

  it("does not record LIMIT in a comment, string or quoted identifier", () => {
    expect(analyzeSql("SELECT 'LIMIT 1', \"LIMIT\" -- LIMIT 1\n/* LIMIT 1 */").limits).toEqual([]);
  });
});

describe("analyzeSql — WHERE conjuncts and IN groups", () => {
  const conjunctTexts = (sql) => {
    const a = analyzeSql(sql);
    return a.writes[0].conjuncts.map((c) =>
      a.tokens.slice(c.start, c.end).map((t) => t.text).join(" "),
    );
  };

  it("splits the WHERE at top-level AND and stops at RETURNING", () => {
    expect(
      conjunctTexts("UPDATE t SET a = 1 WHERE id IN (SELECT id FROM p WHERE x AND y) AND status = 'P' RETURNING id"),
    ).toEqual(["id IN ( SELECT id FROM p WHERE x AND y )", "status = 'P'"]);
  });

  it("does not split at the AND of BETWEEN", () => {
    expect(conjunctTexts("DELETE FROM t WHERE a BETWEEN 1 AND 2 AND b = 3")).toEqual(["a BETWEEN 1 AND 2", "b = 3"]);
  });

  it("makes a top-level OR one hasOr conjunct with no IN group", () => {
    const a = analyzeSql("DELETE FROM t WHERE id IN (SELECT id FROM p) OR x = 1");
    expect(a.writes[0].conjuncts).toHaveLength(1);
    expect(a.writes[0].conjuncts[0]).toMatchObject({ hasOr: true, inGroup: null });
  });

  it("links a conjunct that is exactly <lhs> IN (…) to its IN group", () => {
    const a = analyzeSql("DELETE FROM t WHERE (a, b) IN (SELECT a, b FROM p) AND c = 1");
    const [first, second] = a.writes[0].conjuncts;
    expect(first.inGroup).not.toBeNull();
    expect(keyListOf(a, first.inGroup.lhs.start, first.inGroup.lhs.end)).toEqual(["a", "b"]);
    expect(matchKeySelect(a, first.inGroup.open, first.inGroup.close)).toEqual({ keys: ["a", "b"], from: "p" });
    expect(second.inGroup).toBeNull();
  });

  it("gives every conjunct an inGroup, null when it is not an IN", () => {
    const [a, b] = analyzeSql("DELETE FROM t WHERE a = 1 AND b = 2").writes[0].conjuncts;
    expect(a).toHaveProperty("inGroup", null);
    expect(b).toHaveProperty("inGroup", null);
    expect(analyzeSql("DELETE FROM t WHERE a = 1 OR b = 2").writes[0].conjuncts[0]).toHaveProperty("inGroup", null);
  });

  it("does not link NOT (…) IN or NOT IN", () => {
    expect(analyzeSql("DELETE FROM t WHERE NOT id IN (SELECT id FROM p)").writes[0].conjuncts[0].inGroup).toBeNull();
    expect(analyzeSql("DELETE FROM t WHERE id NOT IN (SELECT id FROM p)").writes[0].conjuncts[0].inGroup).toBeNull();
  });

  it("lists every IN group with its left operand", () => {
    const a = analyzeSql('UPDATE t SET a = 1 WHERE t."id" IN (1) AND x IN (SELECT 1)');
    expect(a.inGroups.map((g) => a.tokens.slice(g.lhs.start, g.lhs.end).map((t) => t.text).join(""))).toEqual([
      't."id"',
      "x",
    ]);
  });
});

describe("keyListOf / matchKeySelect", () => {
  const body = (sql) => {
    const a = analyzeSql(sql);
    const open = a.tokens.findIndex((t) => t.type === TOKEN.LPAREN);
    return matchKeySelect(a, open, a.tokens[open].match);
  };

  it("accepts exactly SELECT <keys> FROM <name>", () => {
    expect(body('(SELECT "id" FROM picked)')).toEqual({ keys: ["id"], from: "picked" });
  });

  it("accepts opaque keys, keeping their substitution text", () => {
    const a = analyzeSql(sqlInputFromSourceText("(SELECT ${keyList} FROM picked)"));
    expect(matchKeySelect(a, 0, a.tokens[0].match)).toEqual({ keys: ["${keyList}"], from: "picked" });
  });

  it("rejects a WHERE, a set operation, a join, a second FROM item and an alias", () => {
    expect(body("(SELECT id FROM picked WHERE true)")).toBeNull();
    expect(body("(SELECT id FROM picked UNION SELECT id FROM t)")).toBeNull();
    expect(body("(SELECT id FROM picked JOIN t USING (id))")).toBeNull();
    expect(body("(SELECT id FROM picked, t)")).toBeNull();
    expect(body("(SELECT id FROM picked p)")).toBeNull();
  });

  it("rejects an expression in the key list", () => {
    expect(body("(SELECT id + 1 FROM picked)")).toBeNull();
  });

  it("keyListOf reads a single key, a parenthesised list, and rejects a trailing comma", () => {
    const a = analyzeSql("id (a, b) (a,)");
    expect(keyListOf(a, 0, 1)).toEqual(["id"]);
    expect(keyListOf(a, 1, 6)).toEqual(["a", "b"]);
    expect(keyListOf(a, 6, 10)).toBeNull();
  });
});

describe("input builders", () => {
  it("sqlInputFromNode and sqlInputFromSourceText agree on a tagged template", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      "x.ts",
      "const q = tag`DELETE FROM ${t}\\n WHERE (${k}) IN (SELECT ${k} FROM ${t} LIMIT $1)`;",
    );
    const tpl = sf.getDescendants().find((n) => n.getKindName() === "TemplateExpression");
    const fromNode = sqlInputFromNode(tpl);
    expect(fromNode.substitutions).toEqual(["t", "k", "k", "t"]);
    expect(fromNode.parts[0]).toBe("DELETE FROM ");
    expect(fromNode.parts[1]).toBe("\n WHERE (");
    const fromText = sqlInputFromSourceText(tpl.getText());
    expect(fromText.substitutions).toEqual(fromNode.substitutions);
  });

  it("sqlInputFromSourceText keeps braces inside a substitution's string together", () => {
    expect(sqlInputFromSourceText("a ${f('}')} b").substitutions).toEqual(["f('}')"]);
  });

  it("rejects malformed input", () => {
    expect(() => tokenizeSql({ parts: ["a"], substitutions: ["b"] })).toThrow(/parts.length/);
  });
});
