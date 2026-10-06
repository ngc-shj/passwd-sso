import { describe, it, expect } from "vitest";
import * as RawSql from "./raw-sql";
import {
  sqlIdentifier,
  trustedSql,
  joinSql,
  renderSql,
  type SqlIdentifier,
  type SqlFragment,
} from "./raw-sql";

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

describe("export surface", () => {
  it("exports exactly sqlIdentifier, trustedSql, joinSql, renderSql", () => {
    expect(Object.keys(RawSql).sort()).toEqual([
      "joinSql",
      "renderSql",
      "sqlIdentifier",
      "trustedSql",
    ]);
  });
});
