import { describe, it, expect } from "vitest";
import * as RawSql from "./raw-sql";
import {
  sqlIdentifier,
  trustedSql,
  joinSql,
  renderSql,
  namesDigestColumn,
  RAW_SQL_REFUSAL_CODE,
  sqlTable,
  TOKEN_TABLE_NAMES,
  type SqlIdentifier,
  type SqlTable,
  type SqlFragment,
} from "./raw-sql";

const TOKEN_TABLE_REFUSAL = expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.TOKEN_TABLE });
const COMMENT_REFUSAL = expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.COMMENT_MARKER });
const BALANCE_REFUSAL = expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.PAREN_BALANCE });
// One token table and one ordinary table: a position rule that only held for a
// token table, or only for another, would pass one of the two.
const TABLE_KINDS = [
  ["a token table", "api_keys"],
  ["a non-token table", "notes"],
] as const;

describe("sqlIdentifier", () => {
  it.each(["users", "tenant_id", "a"])("accepts %j", (name) => {
    expect(() => sqlIdentifier(name)).not.toThrow();
  });

  it.each([
    ["empty string", ""],
    ["uppercase", "Users"],
    ["digit", "table1"],
    ["quote", "users'"],
    ["semicolon", "users;"],
    ["space", "users table"],
    ["unicode", "усers"], // Cyrillic "у", not matched by [a-z]
    ["reserved keyword: select", "select"],
    ["reserved keyword: or", "or"],
    ["reserved keyword: true", "true"],
    ["reserved keyword: null", "null"],
    ["reserved keyword: join", "join"],
    ["reserved keyword: left", "left"],
  ])("rejects %s", (_label, name) => {
    expect(() => sqlIdentifier(name)).toThrow();
  });
});

describe("sqlIdentifier and token tables", () => {
  it.each(TOKEN_TABLE_NAMES)("refuses the token table %s with its code", (name) => {
    expect(() => sqlIdentifier(name)).toThrow(TOKEN_TABLE_REFUSAL);
  });

  it("lists exactly these 13 token tables (pinned apart from the array)", () => {
    expect([...TOKEN_TABLE_NAMES].sort()).toEqual([
      "admin_vault_resets",
      "api_keys",
      "emergency_access_grants",
      "extension_bridge_codes",
      "extension_tokens",
      "mcp_access_tokens",
      "mcp_authorization_codes",
      "mcp_refresh_tokens",
      "mobile_bridge_codes",
      "operator_tokens",
      "password_shares",
      "scim_tokens",
      "service_account_tokens",
    ]);
  });

  it("lists 13 distinct token tables, each a valid table name", () => {
    expect(new Set(TOKEN_TABLE_NAMES).size).toBe(13);
    expect(Object.isFrozen(TOKEN_TABLE_NAMES)).toBe(true);
    for (const name of TOKEN_TABLE_NAMES) {
      expect(() => sqlTable(name)).not.toThrow();
    }
  });

  it.each(["notes", "api", "keys", "api_key", "api_keys_"])(
    "still accepts %j, which is not a token table",
    (name) => {
      expect(() => sqlIdentifier(name)).not.toThrow();
    },
  );
});

describe("sqlTable", () => {
  it.each(["users", "tenant_id", "a", ...TOKEN_TABLE_NAMES])("accepts %j", (name) => {
    expect(() => sqlTable(name)).not.toThrow();
  });

  it.each([
    ["empty string", ""],
    ["uppercase", "Users"],
    ["digit", "table1"],
    ["quote", "users'"],
    ["semicolon", "users;"],
    ["space", "users table"],
    ["unicode", "усers"],
    ["reserved keyword: select", "select"],
    ["reserved keyword: from", "from"],
    ["reserved keyword: user", "user"],
  ])("rejects %s", (_label, name) => {
    expect(() => sqlTable(name)).toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() => sqlTable(1 as unknown as string)).toThrow(TypeError);
  });

  it("is not an identifier: a genuine SqlTable is not accepted by renderSql", () => {
    expect(() => renderSql(sqlTable("notes") as unknown as SqlFragment)).toThrow(TypeError);
  });

  it("is a null-prototype object that throws on conversion", () => {
    const table = sqlTable("notes");
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(() => `${table}`).toThrow(TypeError);
  });

  it("is not accepted by joinSql, as a part or as a separator", () => {
    const table = sqlTable("notes") as unknown as SqlIdentifier;
    expect(() => joinSql([table], trustedSql`, `)).toThrow(TypeError);
    expect(() => joinSql([], table as unknown as SqlFragment)).toThrow(TypeError);
  });
});

describe("trustedSql with a table substitution", () => {
  describe.each(TABLE_KINDS)("%s", (_kind, name) => {
    const t = sqlTable(name);

    it.each([
      ["FROM", "SELECT 1 FROM "],
      ["from, lower case", "select 1 from "],
      ["JOIN, mixed case", "SELECT 1 FROM x JoIn "],
      ["UPDATE", "UPDATE "],
      ["INTO", "INSERT INTO "],
      ["ONLY", "SELECT 1 FROM ONLY "],
      ["a tab", "SELECT 1 FROM\t"],
      ["a newline", "SELECT 1 FROM\n   "],
      ["a CRLF", "SELECT 1 FROM\r\n"],
      ["an opening quote", 'SELECT 1 FROM "'],
      ["a quote with no space", 'SELECT 1 FROM"'],
      ["a keyword at the start of the template", "FROM "],
    ])("renders after %s", (_label, prefix) => {
      const strings = Object.assign([prefix, ""], { raw: [prefix, ""] }) as unknown as TemplateStringsArray;
      expect(renderSql(trustedSql(strings, t))).toBe(prefix + name);
    });

    it("renders after a keyword on the line before it", () => {
      expect(renderSql(trustedSql`SELECT 1
        FROM
        ${t} x`)).toBe(`SELECT 1\n        FROM\n        ${name} x`);
    });

    it("renders after a second substitution once text separates them", () => {
      const other = sqlIdentifier("x");
      expect(renderSql(trustedSql`SELECT ${other} FROM ${t}`)).toBe(`SELECT x FROM ${name}`);
    });

    it("renders as a qualifier", () => {
      expect(renderSql(trustedSql`WHERE ${t}.id = 1`)).toBe(`WHERE ${name}.id = 1`);
    });

    it("renders as a qualifier inside quotes", () => {
      expect(renderSql(trustedSql`WHERE "${t}".id = 1`)).toBe(`WHERE "${name}".id = 1`);
    });

    it("renders a qualifier directly after another substitution", () => {
      const other = sqlIdentifier("x");
      expect(renderSql(trustedSql`${other}${t}.id`)).toBe(`x${name}.id`);
    });

    it.each([
      ["a value position", () => trustedSql`SELECT to_jsonb(${t}) FROM x`],
      ["a cast", () => trustedSql`SELECT ${t}::text FROM x`],
      ["a word that merely ends in a keyword", () => trustedSql`SELECT 1 ts_from ${t}`],
      ["a word that merely ends in a keyword, no space before", () => trustedSql`SELECT 1 xfrom ${t}`],
      ["a word that merely starts with a keyword", () => trustedSql`SELECT 1 FROMX ${t}`],
      ["a keyword with no space or quote", () => trustedSql`SELECT 1 FROM${t}`],
      ["a keyword supplied by a line comment", () => trustedSql`-- FROM
        ${t}`],
      ["a keyword supplied by a block comment", () => trustedSql`/* FROM */ ${t}`],
      ["a line comment in an earlier part, the keyword after a substitution, a newline before it", () => trustedSql`SELECT to_jsonb( -- ${sqlIdentifier("a")} FROM
        ${t}) FROM y`],
      ["a block comment in an earlier part, the keyword after a substitution, a newline before it", () => trustedSql`SELECT to_jsonb( /* ${sqlIdentifier("a")} FROM
        ${t}) */ FROM y`],
      ["a harmless line comment in an earlier part (any comment marker before the table)", () => trustedSql`-- note
        SELECT ${sqlIdentifier("a")} FROM ${t}`],
      ["a $ before a keyword", () => trustedSql`SELECT 1 ts$from ${t}`],
      ["a digit before a keyword", () => trustedSql`SELECT 1 x1from ${t}`],
      ["a comment before a qualifier", () => trustedSql`-- x
        ${t}.id`],
      ["a keyword other than the five", () => trustedSql`SELECT 1 WHERE ${t}`],
      ["a keyword followed by a comma list", () => trustedSql`SELECT 1 FROM x, ${t}`],
      ["the start of the template with no keyword", () => trustedSql`${t}`],
      ["a position directly after another substitution", () => trustedSql`SELECT 1 FROM ${sqlIdentifier("x")}${t}`],
      ["a keyword ending a part that follows a substitution mid-word", () => trustedSql`${sqlIdentifier("ts")}from ${t}`],
      ["a dot that is not directly after it", () => trustedSql`SELECT ${t} .id`],
    ])("refuses %s", (_label, build) => {
      expect(build).toThrow(TOKEN_TABLE_REFUSAL);
    });
  });

  it("refuses a forged look-alike table, as it does for an identifier", () => {
    const forgedTables = [
      ["a plain string", "notes"],
      ["a JSON-parsed object", JSON.parse('{"__sqlTable":true}')],
      ["an object literal with the same keys", { __sqlTable: true }],
      ["a frozen copy of a genuine table", Object.freeze({ ...sqlTable("notes") })],
      ["a spread copy of a genuine table", { ...sqlTable("notes") }],
    ] as const;
    for (const [, forged] of forgedTables) {
      expect(() =>
        trustedSql`SELECT * FROM ${forged as unknown as SqlTable}`,
      ).toThrow(TypeError);
    }
  });

  it("does not take an identifier for a table: an identifier keeps its position-free behavior", () => {
    expect(renderSql(trustedSql`SELECT to_jsonb(${sqlIdentifier("notes")})`)).toBe("SELECT to_jsonb(notes)");
  });
});

describe("trustedSql", () => {
  it("renders a zero-substitution template's text exactly", () => {
    const fragment = trustedSql`SELECT 1`;
    expect(renderSql(fragment)).toBe("SELECT 1");
  });

  it("substitutes a genuine identifier's registered text", () => {
    const table = sqlIdentifier("users");
    const fragment = trustedSql`SELECT * FROM ${table}`;
    expect(renderSql(fragment)).toBe("SELECT * FROM users");
  });

  it("substitutes a genuine fragment's registered text", () => {
    const inner = trustedSql`a = 1`;
    const fragment = trustedSql`SELECT * FROM t WHERE ${inner}`;
    expect(renderSql(fragment)).toBe("SELECT * FROM t WHERE a = 1");
  });

  it.each([-1, NaN, Infinity, 1.5, 2 ** 53])(
    "rejects numeric substitution %s",
    (n) => {
      expect(() => trustedSql`LIMIT ${n}`).toThrow(TypeError);
    },
  );

  it("renders a non-negative safe integer substitution", () => {
    const fragment = trustedSql`LIMIT ${50}`;
    expect(renderSql(fragment)).toBe("LIMIT 50");
  });

  it.each([
    ["a plain string", "users"],
    ["a JSON-parsed object", JSON.parse('{"__sqlIdentifier":true}')],
    ["an object literal with the same keys", { __sqlIdentifier: true }],
    [
      "a frozen copy of a genuine identifier",
      Object.freeze({ ...sqlIdentifier("users") }),
    ],
    ["a spread copy of a genuine identifier", { ...sqlIdentifier("users") }],
  ])("rejects a forged substitution: %s", (_label, forged) => {
    expect(() =>
      trustedSql`SELECT * FROM ${forged as unknown as SqlIdentifier}`,
    ).toThrow(TypeError);
  });
});

describe("trustedSql refuses a comment marker anywhere in a template's own text", () => {
  it.each([
    ["a line comment marker", () => trustedSql`SELECT 1 -- note`],
    ["a block comment marker", () => trustedSql`SELECT 1 /* note */`],
    ["a marker inside a string", () => trustedSql`SELECT '--'`],
    ["a marker inside a quoted identifier", () => trustedSql`SELECT "a/*b" FROM x`],
    ["a marker that is the whole template (a fragment)", () => trustedSql`-- `],
    ["a marker after the last table (the position test passed first)", () => trustedSql`SELECT 1 FROM ${sqlTable("notes")} -- x`],
  ])("refuses %s", (_label, build) => {
    expect(build).toThrow(COMMENT_REFUSAL);
  });

  it("cannot build a comment fragment to hide a keyword across templates", () => {
    // The fragment itself is refused, so `${c} from\n ${t}` never gets a keyword the text test would trust.
    expect(() => {
      const c = trustedSql`-- `;
      return trustedSql`SELECT to_jsonb(${c} from
        ${sqlTable("api_keys")})`;
    }).toThrow(COMMENT_REFUSAL);
  });

  it("refuses a `--` assembled across a substitution (F7)", () => {
    const f = trustedSql`SELECT x -`;
    expect(() => trustedSql`${f}- ${sqlIdentifier("a")} FROM
        ${sqlTable("api_keys")}`).toThrow(COMMENT_REFUSAL);
  });

  it("refuses a `/*` assembled across a substitution", () => {
    const f = trustedSql`SELECT x /`;
    expect(() => trustedSql`${f}* ${sqlIdentifier("a")} FROM
        ${sqlTable("api_keys")} */`).toThrow(COMMENT_REFUSAL);
  });

  it("refuses a marker that joinSql assembles from a part and a separator", () => {
    const a = trustedSql`a-`;
    const b = trustedSql`b`;
    expect(() => joinSql([a, b], trustedSql`-`)).toThrow(COMMENT_REFUSAL);
  });

  it("refuses a marker that joinSql assembles from two parts and an empty separator", () => {
    expect(() => joinSql([trustedSql`/`, trustedSql`*`], trustedSql``)).toThrow(COMMENT_REFUSAL);
  });

  it("accepts the same fragments joined and assembled without a marker", () => {
    const f = trustedSql`SELECT x -`;
    expect(() => trustedSql`${f} 1 FROM ${sqlTable("api_keys")}`).not.toThrow();
    expect(() => joinSql([trustedSql`a-`, trustedSql`b`], trustedSql`, `)).not.toThrow();
  });

  it.each([
    ["a single dash and a division", () => trustedSql`SELECT 1 - 2, 4 / 2`],
    ["a slash and a star that do not touch", () => trustedSql`SELECT 2 / * 3`],
    ["a template with no marker and a table", () => trustedSql`SELECT 1 FROM ${sqlTable("notes")}`],
  ])("accepts %s", (_label, build) => {
    expect(build).not.toThrow();
  });
});

describe("trustedSql refuses unbalanced parentheses in its assembled text (S25)", () => {
  it.each([
    ["an opening fragment (the call split before `from`)", () => trustedSql`SELECT trim(both`],
    ["a closing fragment (the mirror form)", () => trustedSql`from ${sqlTable("api_keys")})`],
    ["a closing parenthesis before an opening one", () => trustedSql`) (`],
    ["a lone closing parenthesis", () => trustedSql`)`],
    ["an opening parenthesis closed only by a substitution's text", () => trustedSql`SELECT (${sqlIdentifier("a")}`],
  ])("refuses %s", (_label, build) => {
    expect(build).toThrow(BALANCE_REFUSAL);
  });

  it("cannot build the trim(both ... from table) split across two fragments", () => {
    expect(() => {
      const head = trustedSql`SELECT trim(both`;
      return trustedSql`${head} from ${sqlTable("api_keys")})`;
    }).toThrow(BALANCE_REFUSAL);
  });

  it.each([
    ["a call with its argument and a table", () => trustedSql`SELECT trim(both x from ${sqlTable("notes")})`],
    ["nested balanced groups", () => trustedSql`SELECT ((1 + 2) * (3))`],
    ["a template with no parenthesis", () => trustedSql`SELECT 1`],
    ["balanced fragments embedded in a balanced template", () => trustedSql`SELECT (${trustedSql`1 + (2)`})`],
  ])("accepts %s", (_label, build) => {
    expect(build).not.toThrow();
  });
});

describe("joinSql", () => {
  const sep = trustedSql`, `;

  it("renders empty text for zero parts", () => {
    expect(renderSql(joinSql([], sep))).toBe("");
  });

  it("renders a single part with no separator", () => {
    const a = sqlIdentifier("a");
    expect(renderSql(joinSql([a], sep))).toBe("a");
  });

  it("joins n parts with the separator between each", () => {
    const parts = [sqlIdentifier("a"), sqlIdentifier("b"), sqlIdentifier("c")];
    expect(renderSql(joinSql(parts, sep))).toBe("a, b, c");
  });

  it("rejects a non-genuine separator", () => {
    expect(() => joinSql([], "x" as unknown as SqlFragment)).toThrow(TypeError);
  });

  it("rejects a non-genuine part", () => {
    expect(() =>
      joinSql(["x" as unknown as SqlIdentifier], sep),
    ).toThrow(TypeError);
  });
});

describe("renderSql", () => {
  it("returns the exact fragment text", () => {
    const fragment = trustedSql`SELECT 1`;
    expect(renderSql(fragment)).toBe("SELECT 1");
  });

  it("rejects a genuine SqlIdentifier — an identifier is not a fragment", () => {
    const id = sqlIdentifier("users");
    expect(() => renderSql(id as unknown as SqlFragment)).toThrow(TypeError);
  });

  // The bearer passkey gate (C7) refuses the digest column names in source
  // literals; a name spliced from identifiers only exists once rendered.
  it.each([
    ["an identifier spliced after a literal prefix", () => trustedSql`SELECT id FROM api_keys WHERE token_${sqlIdentifier("hash")} = $1`],
    ["the code column, upper-case prefix", () => trustedSql`SELECT id FROM mcp_authorization_codes WHERE CODE_${sqlIdentifier("hash")} = $1`],
    ["a joinSql of identifiers", () => joinSql([sqlIdentifier("token"), sqlIdentifier("hash")], trustedSql`_`)],
    ["the refresh-rotation column", () => trustedSql`SELECT id FROM mcp_refresh_tokens WHERE replaced_by_${sqlIdentifier("hash")} = $1`],
  ])("refuses rendered text naming a digest column: %s", (_label, build) => {
    expect(() => renderSql(build())).toThrow(
      expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.DIGEST_COLUMN }),
    );
  });

  // C7 refuses the Unicode-escape forms in source literals; an identifier
  // spliced in front of a literal ampersand forms one only once rendered.
  it.each([
    ["the U-ampersand prefix spliced from an identifier", () => trustedSql`SELECT id FROM api_keys WHERE ${sqlIdentifier("u")}&"token\\005fhash" = $1`],
    ["the escape clause spliced from an identifier", () => trustedSql`SELECT id FROM t WHERE x = 'a' ${sqlIdentifier("uescape")} '!'`],
    ["the escape clause, upper-case", () => trustedSql`SELECT id FROM t WHERE ${sqlIdentifier("u")}ESCAPE`],
  ])("refuses rendered text holding a Unicode-escape form: %s", (_label, build) => {
    expect(() => renderSql(build())).toThrow(
      expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.UNICODE_ESCAPE }),
    );
  });

  it.each([
    ["a bitwise and", trustedSql`SELECT a & b FROM t`],
    ["an ampersand after a spaced u (no prefix)", trustedSql`SELECT ${sqlIdentifier("u")} & b FROM t`],
    ["a literal 'escape'", trustedSql`SELECT 'escape' FROM t`],
  ])("renders text with no Unicode-escape form: %s", (_label, fragment) => {
    expect(() => renderSql(fragment)).not.toThrow();
  });

  it("renders spliced identifiers that do not form a digest column name", () => {
    const fragment = trustedSql`SELECT ${sqlIdentifier("token")}, ${sqlIdentifier("hash")} FROM notes`;
    expect(renderSql(fragment)).toBe("SELECT token, hash FROM notes");
  });

  it.each([
    ["a plain string", "SELECT 1"],
    ["a JSON-parsed object", JSON.parse('{"__sqlFragment":true}')],
    ["an object literal with the same keys", { __sqlFragment: true }],
    [
      "a frozen copy of a genuine fragment",
      Object.freeze({ ...trustedSql`SELECT 1` }),
    ],
    ["a spread copy of a genuine fragment", { ...trustedSql`SELECT 1` }],
  ])("rejects a forged fragment: %s", (_label, forged) => {
    expect(() => renderSql(forged as unknown as SqlFragment)).toThrow(
      TypeError,
    );
  });
});

describe("a genuine value throws on every conversion path", () => {
  it("throws in a template literal", () => {
    const frag = trustedSql`SELECT 1`;
    expect(() => `${frag}`).toThrow(TypeError);
  });

  it("throws with string concatenation (+)", () => {
    const frag = trustedSql`SELECT 1` as unknown as string;
    expect(() => "" + frag).toThrow(TypeError);
  });

  it("throws under String()", () => {
    const frag = trustedSql`SELECT 1`;
    expect(() => String(frag)).toThrow(TypeError);
  });

  it("throws on a direct .toString() call", () => {
    const frag = trustedSql`SELECT 1` as unknown as { toString(): string };
    expect(() => frag.toString()).toThrow(TypeError);
  });

  it("throws on a direct .valueOf() call", () => {
    const frag = trustedSql`SELECT 1` as unknown as { valueOf(): unknown };
    expect(() => frag.valueOf()).toThrow(TypeError);
  });

  it("throws under JSON.stringify", () => {
    const frag = trustedSql`SELECT 1`;
    expect(() => JSON.stringify(frag)).toThrow(TypeError);
  });
});

describe("genuine-value shape", () => {
  it("has a null prototype for both identifiers and fragments", () => {
    expect(Object.getPrototypeOf(sqlIdentifier("users"))).toBeNull();
    expect(Object.getPrototypeOf(trustedSql`SELECT 1`)).toBeNull();
  });

  it("rejects an Object.prototype-based look-alike (contrast case for the null-prototype check)", () => {
    const lookalike = { toString: () => "SELECT 1" };
    expect(() => renderSql(lookalike as unknown as SqlFragment)).toThrow(
      TypeError,
    );
  });

  it("has exactly the four throwing conversion members as own properties — a direct call on a null-prototype object throws 'not a function' regardless, so this checks presence, not just the call's throw", () => {
    const frag = trustedSql`SELECT 1` as unknown as Record<PropertyKey, unknown>;
    expect(Object.getOwnPropertyNames(frag).sort()).toEqual([
      "toJSON",
      "toString",
      "valueOf",
    ]);
    expect(Object.getOwnPropertySymbols(frag)).toEqual([Symbol.toPrimitive]);
    expect(typeof frag.toString).toBe("function");
    expect(typeof frag.valueOf).toBe("function");
    expect(typeof frag.toJSON).toBe("function");
    expect(typeof frag[Symbol.toPrimitive]).toBe("function");
    expect(() => (frag.toString as () => string)()).toThrow(TypeError);
    expect(() => (frag.valueOf as () => unknown)()).toThrow(TypeError);
    expect(() => (frag.toJSON as () => unknown)()).toThrow(TypeError);
    expect(() =>
      (frag[Symbol.toPrimitive] as (hint: string) => unknown)("default"),
    ).toThrow(TypeError);
  });

  it("no value reachable from a genuine value through constructor/prototype walks is accepted by renderSql", () => {
    const frag = trustedSql`SELECT 1` as unknown as {
      toString: { constructor: unknown };
    };
    const toStringMember = frag.toString;
    expect(typeof toStringMember).toBe("function");
    expect(() => renderSql(toStringMember as unknown as SqlFragment)).toThrow(
      TypeError,
    );

    const ctor = toStringMember.constructor;
    expect(ctor).toBe(Function);
    expect(() => renderSql(ctor as unknown as SqlFragment)).toThrow(
      TypeError,
    );
    expect(() =>
      renderSql(Function.prototype as unknown as SqlFragment),
    ).toThrow(TypeError);
  });
});

describe("tamper resistance of captured built-ins", () => {
  it("ignores a post-import replacement of WeakMap.prototype.get, Function.prototype.call, Array.prototype[Symbol.iterator], and Object.freeze", () => {
    const originalWeakMapGet = WeakMap.prototype.get;
    const originalFunctionCall = Function.prototype.call;
    const originalArrayIterator = Array.prototype[Symbol.iterator];
    const originalFreeze = Object.freeze;
    let caught: unknown;
    // trustedSql/joinSql read their caller arrays by index, never via
    // Array.prototype[Symbol.iterator] — exercise both during the same
    // tamper window a for…of implementation would not survive.
    let trustedResult: string | undefined;
    let joinResult: string | undefined;
    try {
      WeakMap.prototype.get = function () {
        return "forged-text";
      };
      Function.prototype.call = function () {
        return "forged-text" as never;
      };
      Array.prototype[Symbol.iterator] = function () {
        throw new Error("tampered iterator — must not be reached");
      } as unknown as typeof originalArrayIterator;
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze;

      const forged = {};
      try {
        renderSql(forged as unknown as SqlFragment);
      } catch (e) {
        caught = e;
      }
      try {
        const id = sqlIdentifier("users");
        trustedResult = renderSql(trustedSql`SELECT * FROM ${id}`);
      } catch {
        trustedResult = undefined;
      }
      try {
        const joined = joinSql(
          [sqlIdentifier("a"), sqlIdentifier("b")],
          trustedSql`, `,
        );
        joinResult = renderSql(joined);
      } catch {
        joinResult = undefined;
      }
    } finally {
      WeakMap.prototype.get = originalWeakMapGet;
      Function.prototype.call = originalFunctionCall;
      Array.prototype[Symbol.iterator] = originalArrayIterator;
      Object.freeze = originalFreeze;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(trustedResult).toBe("SELECT * FROM users");
    expect(joinResult).toBe("a, b");
  });
});

describe("tamper resistance of captured validation built-ins (F5)", () => {
  it("ignores a post-import replacement of RegExp.prototype.exec/test and Set.prototype.has", () => {
    const originalExec = RegExp.prototype.exec;
    const originalTest = RegExp.prototype.test;
    const originalHas = Set.prototype.has;
    let rejectedBadSyntax: unknown;
    let rejectedReserved: unknown;
    let accepted: SqlIdentifier | undefined;
    try {
      // A tampered .exec/.test would make ANY name look like it matches
      // ^[a-z_]+$, and a tampered Set.has would make ANY name look
      // not-reserved — sqlIdentifier must still reject through the bound
      // references it captured at module load.
      RegExp.prototype.exec = function () {
        return ["forged"] as unknown as RegExpExecArray;
      };
      RegExp.prototype.test = function () {
        return true;
      };
      Set.prototype.has = function () {
        return false;
      };
      try {
        sqlIdentifier("Users';--");
      } catch (e) {
        rejectedBadSyntax = e;
      }
      try {
        sqlIdentifier("select");
      } catch (e) {
        rejectedReserved = e;
      }
      accepted = sqlIdentifier("tenant_id");
    } finally {
      RegExp.prototype.exec = originalExec;
      RegExp.prototype.test = originalTest;
      Set.prototype.has = originalHas;
    }
    expect(rejectedBadSyntax).toBeInstanceOf(Error);
    expect(rejectedReserved).toBeInstanceOf(Error);
    expect(accepted).toBeDefined();
  });
});

describe("tamper resistance of renderSql's refusal patterns", () => {
  it("still refuses a digest splice when RegExp.prototype.exec/test report no match", () => {
    const originalExec = RegExp.prototype.exec;
    const originalTest = RegExp.prototype.test;
    let refused: unknown;
    try {
      RegExp.prototype.exec = function () {
        return null;
      };
      RegExp.prototype.test = function () {
        return false;
      };
      try {
        renderSql(trustedSql`SELECT id FROM api_keys WHERE token_${sqlIdentifier("hash")} = $1`);
      } catch (e) {
        refused = e;
      }
    } finally {
      RegExp.prototype.exec = originalExec;
      RegExp.prototype.test = originalTest;
    }
    expect(refused).toEqual(
      expect.objectContaining({ code: RAW_SQL_REFUSAL_CODE.DIGEST_COLUMN }),
    );
  });

  it("still renders SELECT 1 when RegExp.prototype.exec/test report a match", () => {
    const originalExec = RegExp.prototype.exec;
    const originalTest = RegExp.prototype.test;
    let rendered: unknown;
    try {
      RegExp.prototype.exec = function () {
        return ["forged"] as unknown as RegExpExecArray;
      };
      RegExp.prototype.test = function () {
        return true;
      };
      rendered = renderSql(trustedSql`SELECT 1`);
    } finally {
      RegExp.prototype.exec = originalExec;
      RegExp.prototype.test = originalTest;
    }
    expect(rendered).toBe("SELECT 1");
  });
});

describe("tamper resistance of the table position rule", () => {
  it("ignores a post-import replacement of RegExp.prototype.exec/test, Set.prototype.has and Array.prototype.includes", () => {
    const originalExec = RegExp.prototype.exec;
    const originalTest = RegExp.prototype.test;
    const originalHas = Set.prototype.has;
    const originalIncludes = Array.prototype.includes;
    let identifierRefusal: unknown;
    let valueRefusal: unknown;
    let rendered: string | undefined;
    let rejectedBadSyntax: unknown;
    try {
      // Both directions: a "no match" exec would refuse the legal position, a
      // "match" exec would admit the value position; Set.has / includes
      // reporting false would let a token table through sqlIdentifier.
      RegExp.prototype.exec = function () {
        return null;
      };
      RegExp.prototype.test = function () {
        return false;
      };
      Set.prototype.has = function () {
        return false;
      };
      Array.prototype.includes = function () {
        return false;
      };
      try {
        sqlIdentifier("api_keys");
      } catch (e) {
        identifierRefusal = e;
      }
      try {
        sqlTable("Users';--");
      } catch (e) {
        rejectedBadSyntax = e;
      }
      try {
        void trustedSql`SELECT to_jsonb(${sqlTable("api_keys")})`;
      } catch (e) {
        valueRefusal = e;
      }
      try {
        rendered = renderSql(trustedSql`SELECT 1 FROM ${sqlTable("api_keys")}`);
      } catch {
        rendered = undefined;
      }
    } finally {
      RegExp.prototype.exec = originalExec;
      RegExp.prototype.test = originalTest;
      Set.prototype.has = originalHas;
      Array.prototype.includes = originalIncludes;
    }
    expect(identifierRefusal).toEqual(TOKEN_TABLE_REFUSAL);
    expect(rejectedBadSyntax).toBeInstanceOf(Error);
    expect(valueRefusal).toEqual(TOKEN_TABLE_REFUSAL);
    expect(rendered).toBe("SELECT 1 FROM api_keys");
  });

  it("still admits a legal position and refuses a value position when RegExp.prototype.exec reports a match", () => {
    const originalExec = RegExp.prototype.exec;
    const originalTest = RegExp.prototype.test;
    let valueRefusal: unknown;
    let rendered: string | undefined;
    try {
      RegExp.prototype.exec = function () {
        return [""] as unknown as RegExpExecArray;
      };
      RegExp.prototype.test = function () {
        return true;
      };
      try {
        void trustedSql`SELECT to_jsonb(${sqlTable("notes")})`;
      } catch (e) {
        valueRefusal = e;
      }
      rendered = renderSql(trustedSql`SELECT 1 FROM ${sqlTable("notes")}`);
    } finally {
      RegExp.prototype.exec = originalExec;
      RegExp.prototype.test = originalTest;
    }
    expect(valueRefusal).toEqual(TOKEN_TABLE_REFUSAL);
    expect(rendered).toBe("SELECT 1 FROM notes");
  });
});

describe("namesDigestColumn", () => {
  it.each(["token_hash", "CODE_HASH", "replaced_by_hash"])("is true for %j", (text) => {
    expect(namesDigestColumn(text)).toBe(true);
  });

  it.each(["token", "hash", "tokenhash", "token hash"])("is false for %j", (text) => {
    expect(namesDigestColumn(text)).toBe(false);
  });
});

describe("refusal codes", () => {
  it("has exactly these code values (a collision would let one refusal pass for another)", () => {
    expect(RAW_SQL_REFUSAL_CODE).toEqual({
      DIGEST_COLUMN: "RAW_SQL_DIGEST_COLUMN",
      UNICODE_ESCAPE: "RAW_SQL_UNICODE_ESCAPE",
      TOKEN_TABLE: "RAW_SQL_TOKEN_TABLE",
      COMMENT_MARKER: "RAW_SQL_COMMENT_MARKER",
      PAREN_BALANCE: "RAW_SQL_PAREN_BALANCE",
    });
  });
});

describe("export surface", () => {
  it("exports exactly the builders, renderSql, the digest predicate, the token table list and the refusal codes", () => {
    expect(Object.keys(RawSql).sort()).toEqual([
      "RAW_SQL_REFUSAL_CODE",
      "TOKEN_TABLE_NAMES",
      "joinSql",
      "namesDigestColumn",
      "renderSql",
      "sqlIdentifier",
      "sqlTable",
      "trustedSql",
    ]);
  });
});
