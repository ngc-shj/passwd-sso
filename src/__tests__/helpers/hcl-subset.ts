/**
 * A parser and evaluator for the subset of HCL that infra/terraform uses, so
 * static tests can read a resource's attributes as values — a bucket policy
 * as the JSON it renders, a task definition's container list — instead of
 * matching its text.
 *
 * Evaluation resolves `var.*` (an override, else the variable's default),
 * `local.*`, `module.<name>.<output>` (the module's own output expression,
 * with the call's arguments as its variables) and `each.*`. Everything else —
 * a resource attribute such as `aws_s3_bucket.x[0].arn`, a variable with no
 * default — becomes an `HclUnknown` carrying its reference, which renders as
 * `<ref:...>` inside a string. `jsonencode(x)` returns `x` itself.
 *
 * Anything outside the subset (heredocs, template directives, an unlisted
 * function) throws: a test must fail on HCL it does not model, not read it as
 * something else.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export class HclUnknown {
  constructor(readonly ref: string) {}
  toString(): string {
    return `<ref:${this.ref}>`;
  }
  toJSON(): string {
    return this.toString();
  }
}

/** `v` with every unknown replaced by its `<ref:...>` string. */
export function plain(v: unknown): unknown {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

type Step = { kind: "attr"; name: string } | { kind: "index"; expr: HclExpr } | { kind: "splat" };

export type HclExpr =
  | { t: "lit"; v: unknown }
  | { t: "tmpl"; parts: Array<string | HclExpr> }
  | { t: "name"; name: string }
  | { t: "trav"; base: HclExpr; steps: Step[]; src: string }
  | { t: "call"; fn: string; args: HclExpr[] }
  | { t: "list"; items: HclExpr[] }
  | { t: "obj"; items: Array<{ key: HclExpr; value: HclExpr }> }
  | { t: "for"; obj: boolean; k?: string; v: string; coll: HclExpr; key?: HclExpr; val: HclExpr; cond?: HclExpr }
  | { t: "cond"; c: HclExpr; a: HclExpr; b: HclExpr }
  | { t: "bin"; op: string; l: HclExpr; r: HclExpr }
  | { t: "un"; op: string; e: HclExpr };

export type HclBlock = { type: string; labels: string[]; body: HclBody };
export type HclBody = { attrs: Record<string, HclExpr>; blocks: HclBlock[] };

// ─── Parser ─────────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly file: string,
  ) {}

  private fail(msg: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new Error(`${this.file}:${line}: ${msg}`);
  }

  private peek(n = 0): string {
    return this.s[this.i + n] ?? "";
  }

  private startsWith(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }

  /** Skip blanks and comments; newlines too when `nl`. */
  private skip(nl: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || (nl && c === "\n")) this.i++;
      else if (c === "#" || this.startsWith("//")) {
        while (this.i < this.s.length && this.peek() !== "\n") this.i++;
      } else if (this.startsWith("/*")) {
        const end = this.s.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("unterminated comment");
        this.i = end + 2;
      } else return;
    }
  }

  private expect(t: string): void {
    if (!this.startsWith(t)) this.fail(`expected ${JSON.stringify(t)}, found ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    this.i += t.length;
  }

  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.s.slice(this.i));
    if (!m) this.fail(`expected identifier, found ${JSON.stringify(this.s.slice(this.i, this.i + 20))}`);
    this.i += m[0].length;
    return m[0];
  }

  parseFile(): HclBody {
    const body = this.parseBody();
    this.skip(true);
    if (this.i < this.s.length) this.fail("unexpected input");
    return body;
  }

  private parseBody(): HclBody {
    const body: HclBody = { attrs: {}, blocks: [] };
    for (;;) {
      this.skip(true);
      if (this.i >= this.s.length || this.peek() === "}") return body;
      const name = this.ident();
      this.skip(false);
      if (this.peek() === "=" && this.peek(1) !== "=") {
        this.i++;
        this.skip(false);
        if (name in body.attrs) this.fail(`duplicate attribute ${name}`);
        body.attrs[name] = this.parseExpr(false);
        this.skip(false);
        if (this.i < this.s.length && this.peek() !== "\n" && this.peek() !== "}") this.fail("expected end of attribute");
        continue;
      }
      const labels: string[] = [];
      while (this.peek() !== "{") {
        if (this.peek() === '"') {
          const tmpl = this.parseTemplate();
          if (tmpl.t !== "tmpl" || tmpl.parts.some((p) => typeof p !== "string")) this.fail("interpolated block label");
          labels.push(tmpl.parts.join(""));
        } else labels.push(this.ident());
        this.skip(false);
      }
      this.expect("{");
      const inner = this.parseBody();
      this.expect("}");
      body.blocks.push({ type: name, labels, body: inner });
    }
  }

  parseExpr(nl: boolean): HclExpr {
    const c = this.parseBinary(0, nl);
    this.skip(nl);
    if (this.peek() !== "?") return c;
    this.i++;
    this.skip(true);
    const a = this.parseExpr(true);
    this.skip(true);
    this.expect(":");
    this.skip(true);
    const b = this.parseExpr(nl);
    return { t: "cond", c, a, b };
  }

  private static readonly LEVELS = [["||"], ["&&"], ["==", "!="], ["<=", ">=", "<", ">"], ["+", "-"], ["*", "/", "%"]];

  private parseBinary(level: number, nl: boolean): HclExpr {
    if (level >= Parser.LEVELS.length) return this.parseUnary(nl);
    let l = this.parseBinary(level + 1, nl);
    for (;;) {
      const save = this.i;
      this.skip(nl);
      const op = Parser.LEVELS[level].find((o) => this.startsWith(o));
      if (!op) {
        this.i = save;
        return l;
      }
      this.i += op.length;
      this.skip(true);
      const r = this.parseBinary(level + 1, nl);
      l = { t: "bin", op, l, r };
    }
  }

  private parseUnary(nl: boolean): HclExpr {
    if (this.peek() === "!" || (this.peek() === "-" && !/[0-9]/.test(this.peek(1)))) {
      const op = this.peek();
      this.i++;
      this.skip(nl);
      return { t: "un", op, e: this.parseUnary(nl) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): HclExpr {
    const start = this.i;
    const base = this.parsePrimary();
    const steps: Step[] = [];
    for (;;) {
      if (this.peek() === "." && /[A-Za-z_]/.test(this.peek(1))) {
        this.i++;
        steps.push({ kind: "attr", name: this.ident() });
      } else if (this.peek() === "." && /[0-9]/.test(this.peek(1))) {
        this.i++;
        const m = /^[0-9]+/.exec(this.s.slice(this.i)) as RegExpExecArray;
        this.i += m[0].length;
        steps.push({ kind: "index", expr: { t: "lit", v: Number(m[0]) } });
      } else if (this.startsWith("[*]") || this.startsWith(".*")) {
        this.i += 3 - (this.startsWith(".*") ? 1 : 0);
        steps.push({ kind: "splat" });
      } else if (this.peek() === "[" && (base.t === "name" || steps.length > 0 || base.t === "call")) {
        this.i++;
        this.skip(true);
        const expr = this.parseExpr(true);
        this.skip(true);
        this.expect("]");
        steps.push({ kind: "index", expr });
      } else break;
    }
    if (steps.length === 0) return base;
    return { t: "trav", base, steps, src: this.s.slice(start, this.i).replace(/\s+/g, "") };
  }

  private parsePrimary(): HclExpr {
    const c = this.peek();
    if (c === '"') return this.parseTemplate();
    if (this.startsWith("<<")) this.fail("heredoc is outside the modelled subset");
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(this.peek(1)))) {
      const m = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i)) as RegExpExecArray;
      this.i += m[0].length;
      return { t: "lit", v: Number(m[0]) };
    }
    if (c === "(") {
      this.i++;
      this.skip(true);
      const e = this.parseExpr(true);
      this.skip(true);
      this.expect(")");
      return e;
    }
    if (c === "[") return this.parseList();
    if (c === "{") return this.parseObject();
    const name = this.ident();
    if (name === "true" || name === "false") return { t: "lit", v: name === "true" };
    if (name === "null") return { t: "lit", v: null };
    if (this.peek() === "(") {
      this.i++;
      const args: HclExpr[] = [];
      for (;;) {
        this.skip(true);
        if (this.peek() === ")") break;
        args.push(this.parseExpr(true));
        this.skip(true);
        if (this.startsWith("...")) this.fail("argument expansion is outside the modelled subset");
        if (this.peek() === ",") this.i++;
        else if (this.peek() !== ")") this.fail("expected , or )");
      }
      this.i++;
      return { t: "call", fn: name, args };
    }
    return { t: "name", name };
  }

  private isFor(): boolean {
    return /^for\s/.test(this.s.slice(this.i, this.i + 4));
  }

  private parseForHead(): { k?: string; v: string; coll: HclExpr } {
    this.expect("for");
    this.skip(true);
    let k: string | undefined;
    let v = this.ident();
    this.skip(true);
    if (this.peek() === ",") {
      this.i++;
      this.skip(true);
      k = v;
      v = this.ident();
      this.skip(true);
    }
    this.expect("in");
    this.skip(true);
    const coll = this.parseExpr(true);
    this.skip(true);
    this.expect(":");
    this.skip(true);
    return { k, v, coll };
  }

  private parseForCond(): HclExpr | undefined {
    this.skip(true);
    if (!/^if\s/.test(this.s.slice(this.i, this.i + 3))) return undefined;
    this.i += 2;
    this.skip(true);
    return this.parseExpr(true);
  }

  private parseList(): HclExpr {
    this.expect("[");
    this.skip(true);
    if (this.isFor()) {
      const head = this.parseForHead();
      const val = this.parseExpr(true);
      const cond = this.parseForCond();
      this.skip(true);
      this.expect("]");
      return { t: "for", obj: false, ...head, val, cond };
    }
    const items: HclExpr[] = [];
    for (;;) {
      this.skip(true);
      if (this.peek() === "]") break;
      items.push(this.parseExpr(true));
      this.skip(true);
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "]") this.fail("expected , or ]");
    }
    this.i++;
    return { t: "list", items };
  }

  private parseObject(): HclExpr {
    this.expect("{");
    this.skip(true);
    if (this.isFor()) {
      const head = this.parseForHead();
      const key = this.parseExpr(true);
      this.skip(true);
      this.expect("=>");
      this.skip(true);
      const val = this.parseExpr(true);
      if (this.startsWith("...")) this.fail("grouping is outside the modelled subset");
      const cond = this.parseForCond();
      this.skip(true);
      this.expect("}");
      return { t: "for", obj: true, ...head, key, val, cond };
    }
    const items: Array<{ key: HclExpr; value: HclExpr }> = [];
    for (;;) {
      this.skip(true);
      if (this.peek() === "}") break;
      let key: HclExpr;
      if (this.peek() === '"') key = this.parseTemplate();
      else if (this.peek() === "(") key = this.parsePrimary();
      else key = { t: "lit", v: this.ident() };
      this.skip(false);
      if (this.peek() === "=" || this.peek() === ":") this.i++;
      else this.fail("expected = in object");
      this.skip(false);
      items.push({ key, value: this.parseExpr(false) });
      this.skip(false);
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== "\n" && this.peek() !== "}") this.fail("expected end of object item");
    }
    this.i++;
    return { t: "obj", items };
  }

  private parseTemplate(): HclExpr {
    this.expect('"');
    const parts: Array<string | HclExpr> = [];
    let lit = "";
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated string");
      if (c === '"') {
        this.i++;
        break;
      }
      if (c === "\\") {
        const e = this.peek(1);
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
        if (!(e in map)) this.fail(`unsupported escape \\${e}`);
        lit += map[e];
        this.i += 2;
      } else if (this.startsWith("$${") || this.startsWith("%%{")) {
        lit += this.s.slice(this.i + 1, this.i + 3);
        this.i += 3;
      } else if (this.startsWith("%{")) {
        this.fail("template directives are outside the modelled subset");
      } else if (this.startsWith("${")) {
        this.i += 2;
        if (lit) parts.push(lit);
        lit = "";
        this.skip(true);
        parts.push(this.parseExpr(true));
        this.skip(true);
        this.expect("}");
      } else {
        lit += c;
        this.i++;
      }
    }
    if (lit || parts.length === 0) parts.push(lit);
    return { t: "tmpl", parts };
  }
}

export function parseHcl(text: string, file = "<hcl>"): HclBody {
  return new Parser(text, file).parseFile();
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

export type EvalScope = {
  vars: (name: string) => unknown;
  local: (name: string) => unknown;
  module: (name: string, output: string) => unknown;
  each?: { key: unknown; value: unknown };
  bound?: Record<string, unknown>;
};

function str(v: unknown): string {
  if (v instanceof HclUnknown) return v.toString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`cannot interpolate ${JSON.stringify(v)}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof HclUnknown);
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  jsonencode: (v) => v,
  merge: (...objs) => {
    for (const o of objs) if (!isObject(o)) throw new Error("merge: not an object");
    return Object.assign({}, ...objs);
  },
  concat: (...lists) => {
    for (const l of lists) if (!Array.isArray(l)) throw new Error("concat: not a list");
    return (lists as unknown[][]).flat();
  },
  compact: (list) => (list as unknown[]).filter((v) => v !== "" && v !== null),
  min: (...n) => Math.min(...(n as number[])),
  max: (...n) => Math.max(...(n as number[])),
  tostring: (v) => (v instanceof HclUnknown ? v : str(v)),
  replace: (s, sub, rep) => {
    if (typeof s !== "string" || typeof sub !== "string" || typeof rep !== "string") throw new Error("replace: strings only");
    if (sub.startsWith("/")) throw new Error("replace: regex form is outside the modelled subset");
    return s.split(sub).join(rep);
  },
  split: (sep, s) => (s as string).split(sep as string),
  length: (v) => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : (v as string).length),
  contains: (list, v) => (list as unknown[]).some((x) => deepEqual(x, v)),
  alltrue: (list) => (list as unknown[]).every((x) => x === true),
  can: () => {
    throw new Error("can(): evaluate validations with terraform test, not here");
  },
};

export function evaluate(e: HclExpr, scope: EvalScope): unknown {
  switch (e.t) {
    case "lit":
      return e.v;
    case "tmpl": {
      if (e.parts.length === 1 && typeof e.parts[0] !== "string") return evaluate(e.parts[0], scope);
      return e.parts.map((p) => (typeof p === "string" ? p : str(evaluate(p, scope)))).join("");
    }
    case "name":
      if (scope.bound && e.name in scope.bound) return scope.bound[e.name];
      throw new Error(`bare reference ${e.name}`);
    case "trav":
      return evalTraversal(e, scope);
    case "call": {
      if (e.fn === "try") {
        for (const a of e.args) {
          try {
            return evaluate(a, scope);
          } catch {
            // next alternative
          }
        }
        throw new Error("try: no alternative evaluated");
      }
      const fn = FUNCTIONS[e.fn];
      if (!fn) throw new Error(`unsupported function ${e.fn}()`);
      return fn(...e.args.map((a) => evaluate(a, scope)));
    }
    case "list":
      return e.items.map((i) => evaluate(i, scope));
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const { key, value } of e.items) out[str(evaluate(key, scope))] = evaluate(value, scope);
      return out;
    }
    case "for": {
      const coll = evaluate(e.coll, scope);
      const entries: Array<[unknown, unknown]> = Array.isArray(coll)
        ? coll.map((v, i) => [i, v])
        : isObject(coll)
          ? Object.entries(coll)
          : (() => {
              throw new Error("for: collection is not a list or object");
            })();
      const outList: unknown[] = [];
      const outObj: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        const inner: EvalScope = { ...scope, bound: { ...scope.bound, [e.v]: v, ...(e.k ? { [e.k]: k } : {}) } };
        if (e.cond) {
          const c = evaluate(e.cond, inner);
          if (typeof c !== "boolean") throw new Error("for: condition is not a bool");
          if (!c) continue;
        }
        if (e.obj) outObj[str(evaluate(e.key as HclExpr, inner))] = evaluate(e.val, inner);
        else outList.push(evaluate(e.val, inner));
      }
      return e.obj ? outObj : outList;
    }
    case "cond": {
      const c = evaluate(e.c, scope);
      if (typeof c !== "boolean") throw new Error(`condition is not a known bool: ${str(c)}`);
      return evaluate(c ? e.a : e.b, scope);
    }
    case "un": {
      const v = evaluate(e.e, scope);
      if (e.op === "!") {
        if (typeof v !== "boolean") throw new Error("!: not a bool");
        return !v;
      }
      return -(v as number);
    }
    case "bin": {
      const l = evaluate(e.l, scope);
      if (e.op === "&&" || e.op === "||") {
        if (typeof l !== "boolean") throw new Error(`${e.op}: not a known bool`);
        if (e.op === "&&" ? !l : l) return l;
        const r = evaluate(e.r, scope);
        if (typeof r !== "boolean") throw new Error(`${e.op}: not a known bool`);
        return r;
      }
      const r = evaluate(e.r, scope);
      if (e.op === "==" || e.op === "!=") {
        if (l instanceof HclUnknown || r instanceof HclUnknown) throw new Error(`${e.op} on an unknown value`);
        return e.op === "==" ? deepEqual(l, r) : !deepEqual(l, r);
      }
      if (typeof l !== "number" || typeof r !== "number") throw new Error(`${e.op}: not numbers`);
      switch (e.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        case "<": return l < r;
        case ">": return l > r;
        case "<=": return l <= r;
        case ">=": return l >= r;
      }
      throw new Error(`unsupported operator ${e.op}`);
    }
  }
}

function evalTraversal(e: Extract<HclExpr, { t: "trav" }>, scope: EvalScope): unknown {
  const steps = [...e.steps];
  let value: unknown;
  if (e.base.t === "name" && !(scope.bound && e.base.name in scope.bound)) {
    const root = e.base.name;
    const first = steps[0]?.kind === "attr" ? (steps[0] as { name: string }).name : undefined;
    if (root === "var" && first) {
      steps.shift();
      value = scope.vars(first);
    } else if (root === "local" && first) {
      steps.shift();
      value = scope.local(first);
    } else if (root === "module" && first && steps[1]?.kind === "attr") {
      const output = (steps[1] as { name: string }).name;
      steps.splice(0, 2);
      value = scope.module(first, output);
    } else if (root === "each" && first && scope.each) {
      steps.shift();
      value = first === "key" ? scope.each.key : first === "value" ? scope.each.value : undefined;
      if (value === undefined) throw new Error(`each.${first}`);
    } else {
      // A resource, data source or other reference this evaluator does not
      // know the value of.
      return new HclUnknown(e.src);
    }
  } else value = evaluate(e.base, scope);

  for (const step of steps) {
    if (value instanceof HclUnknown) return new HclUnknown(e.src);
    if (step.kind === "attr") {
      if (!isObject(value) || !(step.name in value)) throw new Error(`no attribute ${step.name} in ${e.src}`);
      value = value[step.name];
    } else if (step.kind === "index") {
      const k = evaluate(step.expr, scope);
      if (Array.isArray(value) && typeof k === "number") value = value[k];
      else if (isObject(value) && typeof k === "string") value = value[k];
      else throw new Error(`cannot index ${e.src}`);
    } else throw new Error(`splat on a known value in ${e.src}`);
  }
  return value;
}

// ─── A configuration directory ──────────────────────────────────────────────

export type EvalOptions = { vars?: Record<string, unknown>; each?: { key: unknown; value: unknown } };

export class TerraformConfig {
  readonly files: Record<string, HclBody> = {};
  private readonly variables = new Map<string, HclBlock>();
  private readonly locals = new Map<string, HclExpr>();
  private readonly modules = new Map<string, HclBlock>();

  /**
   * @param dir       the configuration directory
   * @param overrides file name → replacement text (null removes the file),
   *                  for red fixtures
   * @param moduleOverrides module directory (relative to `dir`) → its own
   *                  overrides
   */
  constructor(
    readonly dir: string,
    overrides: Record<string, string | null> = {},
    private readonly moduleOverrides: Record<string, Record<string, string | null>> = {},
  ) {
    const names = new Set(readdirSync(dir).filter((f) => f.endsWith(".tf")));
    for (const [name, text] of Object.entries(overrides)) {
      if (text === null) names.delete(name);
      else names.add(name);
    }
    for (const name of [...names].sort()) {
      const text = name in overrides ? (overrides[name] as string) : readFileSync(join(dir, name), "utf8");
      const body = parseHcl(text, name);
      this.files[name] = body;
      for (const b of body.blocks) {
        if (b.type === "variable") this.variables.set(b.labels[0], b);
        if (b.type === "module") this.modules.set(b.labels[0], b);
        if (b.type === "locals") {
          for (const [k, v] of Object.entries(b.body.attrs)) {
            if (this.locals.has(k)) throw new Error(`duplicate local ${k}`);
            this.locals.set(k, v);
          }
        }
      }
    }
  }

  blocks(type: string): HclBlock[] {
    return Object.values(this.files).flatMap((f) => f.blocks.filter((b) => b.type === type));
  }

  resources(type: string): HclBlock[] {
    return this.blocks("resource").filter((b) => b.labels[0] === type);
  }

  resource(type: string, name: string): HclBlock {
    const found = this.blocks("resource").find((b) => b.labels[0] === type && b.labels[1] === name);
    if (!found) throw new Error(`no resource ${type}.${name}`);
    return found;
  }

  variable(name: string): HclBlock {
    const v = this.variables.get(name);
    if (!v) throw new Error(`no variable ${name}`);
    return v;
  }

  module(name: string): HclBlock {
    const m = this.modules.get(name);
    if (!m) throw new Error(`no module ${name}`);
    return m;
  }

  scope(opts: EvalOptions = {}, seen: Set<string> = new Set()): EvalScope {
    return {
      vars: (name) => {
        if (opts.vars && name in opts.vars) return opts.vars[name];
        const v = this.variable(name);
        const def = v.body.attrs.default;
        return def ? evaluate(def, this.scope()) : new HclUnknown(`var.${name}`);
      },
      local: (name) => {
        const expr = this.locals.get(name);
        if (!expr) throw new Error(`no local ${name}`);
        if (seen.has(name)) throw new Error(`local cycle at ${name}`);
        return evaluate(expr, this.scope({ ...opts, each: undefined }, new Set([...seen, name])));
      },
      module: (name, output) => {
        const call = this.module(name);
        const source = evaluate(call.body.attrs.source, this.scope());
        if (typeof source !== "string" || !source.startsWith("./")) throw new Error(`module ${name}: local source only`);
        const args: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(call.body.attrs)) {
          if (k !== "source") args[k] = evaluate(v, this.scope({ vars: opts.vars }));
        }
        const mod = new TerraformConfig(resolve(this.dir, source), this.moduleOverrides[source] ?? {});
        const out = mod.blocks("output").find((b) => b.labels[0] === output);
        if (!out) throw new Error(`module ${name} has no output ${output}`);
        return evaluate(out.body.attrs.value, mod.scope({ vars: args }));
      },
      each: opts.each,
    };
  }

  eval(expr: HclExpr, opts: EvalOptions = {}): unknown {
    return evaluate(expr, this.scope(opts));
  }

  /** An attribute of a block, evaluated; throws when absent. */
  attr(block: HclBlock, name: string, opts: EvalOptions = {}): unknown {
    const expr = block.body.attrs[name];
    if (!expr) throw new Error(`no attribute ${name} in ${block.type} ${block.labels.join(".")}`);
    return this.eval(expr, opts);
  }

  /** An expression given as HCL source, evaluated in this configuration. */
  evalText(src: string, opts: EvalOptions = {}): unknown {
    return this.eval(parseHcl(`x = ${src}\n`, "<expr>").attrs.x, opts);
  }

  local(name: string, opts: EvalOptions = {}): unknown {
    return this.scope(opts).local(name);
  }
}

/** The nested blocks of `block` named `type`, in order. */
export function nested(block: HclBlock, type: string): HclBlock[] {
  return block.body.blocks.filter((b) => b.type === type);
}

export const TERRAFORM_DIR = resolve(__dirname, "../../../infra/terraform");
