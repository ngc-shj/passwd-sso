/**
 * SCIM filter parser (RFC 7644 §3.4.2.2).
 *
 * MVP operators: eq, co (contains), sw (starts with), and, or.
 * Security: 256-char limit + attribute whitelist to prevent injection / ReDoS.
 */

/** Maximum filter string length. */
const MAX_FILTER_LENGTH = 256;

/** Attributes allowed in SCIM filters. */
const ALLOWED_FILTER_ATTRIBUTES = new Set([
  "userName",
  "active",
  "externalId",
]);

// ── Types ─────────────────────────────────────────────────────

export type ScimFilterOp = "eq" | "co" | "sw";

export interface ScimFilterNode {
  attr: string;
  op: ScimFilterOp;
  value: string;
}

export interface ScimFilterAnd {
  and: ScimFilterExpression[];
}

export interface ScimFilterOr {
  or: ScimFilterExpression[];
}

export type ScimFilterExpression =
  | ScimFilterNode
  | ScimFilterAnd
  | ScimFilterOr;

// ── Tokeniser ─────────────────────────────────────────────────

type Token =
  | { type: "attr"; value: string }
  | { type: "op"; value: ScimFilterOp }
  | { type: "str"; value: string }
  | { type: "bool"; value: string }
  | { type: "and" }
  | { type: "or" };

const OPS = new Set(["eq", "co", "sw"]);

function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // skip whitespace
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    // quoted string
    if (input[i] === '"') {
      i++; // skip opening quote
      let str = "";
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < len) {
          i++;
          str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i >= len) throw new FilterParseError("Unterminated string");
      i++; // skip closing quote
      tokens.push({ type: "str", value: str });
      continue;
    }

    // word (attr, op, and, or, boolean)
    let word = "";
    while (i < len && input[i] !== " " && input[i] !== "\t" && input[i] !== '"') {
      word += input[i];
      i++;
    }
    if (!word) {
      i++;
      continue;
    }

    const lower = word.toLowerCase();
    if (lower === "and") {
      tokens.push({ type: "and" });
    } else if (lower === "or") {
      tokens.push({ type: "or" });
    } else if (OPS.has(lower)) {
      tokens.push({ type: "op", value: lower as ScimFilterOp });
    } else if (lower === "true" || lower === "false") {
      tokens.push({ type: "bool", value: lower });
    } else {
      tokens.push({ type: "attr", value: word });
    }
  }

  return tokens;
}

// ── Parser ────────────────────────────────────────────────────

export class FilterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterParseError";
  }
}

/**
 * Parse a SCIM filter string into an AST.
 * Throws `FilterParseError` on invalid input.
 */
export function parseScimFilter(filter: string): ScimFilterExpression {
  if (filter.length > MAX_FILTER_LENGTH) {
    throw new FilterParseError(
      `Filter exceeds maximum length of ${MAX_FILTER_LENGTH} characters`,
    );
  }

  const tokens = tokenise(filter);
  if (tokens.length === 0) {
    throw new FilterParseError("Empty filter");
  }

  let pos = 0;

  function parseComparison(): ScimFilterNode {
    const attrToken = tokens[pos];
    if (!attrToken || attrToken.type !== "attr") {
      throw new FilterParseError(
        `Expected attribute at position ${pos}, got ${attrToken?.type ?? "EOF"}`,
      );
    }
    if (!ALLOWED_FILTER_ATTRIBUTES.has(attrToken.value)) {
      throw new FilterParseError(
        `Unsupported filter attribute: ${attrToken.value}`,
      );
    }
    pos++;

    const opToken = tokens[pos];
    if (!opToken || opToken.type !== "op") {
      throw new FilterParseError(
        `Expected operator at position ${pos}, got ${opToken?.type ?? "EOF"}`,
      );
    }
    pos++;

    const valToken = tokens[pos];
    if (!valToken || (valToken.type !== "str" && valToken.type !== "bool")) {
      throw new FilterParseError(
        `Expected value at position ${pos}, got ${valToken?.type ?? "EOF"}`,
      );
    }
    pos++;

    return { attr: attrToken.value, op: opToken.value, value: valToken.value };
  }

  function parseExpression(): ScimFilterExpression {
    let left: ScimFilterExpression = parseComparison();
    let connective: "and" | "or" | null = null;

    while (pos < tokens.length) {
      const next = tokens[pos];
      if (next.type !== "and" && next.type !== "or") break;

      // Reject mixed and/or (RFC 7644 requires and > or precedence,
      // which is not implemented in this MVP parser)
      if (connective !== null && connective !== next.type) {
        throw new FilterParseError(
          "Mixing \"and\" and \"or\" is not supported; use separate requests",
        );
      }
      connective = next.type;

      pos++;
      const right = parseComparison();
      if (connective === "and") {
        if ("and" in left) {
          (left as ScimFilterAnd).and.push(right);
        } else {
          left = { and: [left, right] };
        }
      } else {
        if ("or" in left) {
          (left as ScimFilterOr).or.push(right);
        } else {
          left = { or: [left, right] };
        }
      }
    }

    return left;
  }

  const result = parseExpression();

  if (pos < tokens.length) {
    throw new FilterParseError(
      `Unexpected token at position ${pos}: ${tokens[pos].type}`,
    );
  }

  return result;
}

// ── Prisma WHERE conversion ───────────────────────────────────

/**
 * SCIM attribute → Prisma field mapping.
 *
 * `userName` → User.email (joined via OrgMember → User).
 * `active`  → OrgMember.deactivatedAt presence check.
 * `externalId` → ScimExternalMapping.externalId.
 */

interface PrismaWhere {
  [key: string]: unknown;
}

function comparisonToPrisma(node: ScimFilterNode): PrismaWhere {
  const { attr, op, value } = node;

  if (attr === "active") {
    const isActive = value === "true";
    return isActive
      ? { deactivatedAt: null }
      : { deactivatedAt: { not: null } };
  }

  if (attr === "userName") {
    const normalized = value.toLowerCase();
    const field = "user";
    switch (op) {
      case "eq":
        return { [field]: { is: { email: { equals: normalized, mode: "insensitive" } } } };
      case "co":
        return { [field]: { is: { email: { contains: normalized, mode: "insensitive" } } } };
      case "sw":
        return { [field]: { is: { email: { startsWith: normalized, mode: "insensitive" } } } };
    }
  }

  if (attr === "externalId") {
    // externalId is resolved by caller via ScimExternalMapping lookup.
    // Return empty object — caller injects userId after resolution.
    if (op !== "eq") {
      throw new FilterParseError(
        `Operator "${op}" not supported for externalId`,
      );
    }
    return {};
  }

  throw new FilterParseError(`Unsupported attribute: ${attr}`);
}

/**
 * Convert a parsed SCIM filter AST to a Prisma `where` clause.
 *
 * `externalId` nodes produce empty objects — callers must pre-resolve
 * externalId via `extractExternalIdValue()` + ScimExternalMapping lookup
 * and inject the resulting userId into the WHERE clause.
 */
export function filterToPrismaWhere(
  expr: ScimFilterExpression,
): PrismaWhere {
  if ("and" in expr) {
    return { AND: expr.and.map(filterToPrismaWhere) };
  }
  if ("or" in expr) {
    return { OR: expr.or.map(filterToPrismaWhere) };
  }
  return comparisonToPrisma(expr);
}

/**
 * Extract the value of an `externalId eq "..."` node from anywhere in the AST.
 * Returns `null` if no externalId filter is found.
 */
export function extractExternalIdValue(
  expr: ScimFilterExpression,
): string | null {
  if ("and" in expr) {
    for (const child of expr.and) {
      const v = extractExternalIdValue(child);
      if (v !== null) return v;
    }
    return null;
  }
  if ("or" in expr) {
    for (const child of expr.or) {
      const v = extractExternalIdValue(child);
      if (v !== null) return v;
    }
    return null;
  }
  return expr.attr === "externalId" ? expr.value : null;
}

/**
 * Check if a filter AST contains a specific attribute anywhere (including
 * nested AND/OR branches). Used to detect `active` filters at any depth.
 */
export function hasAttribute(
  expr: ScimFilterExpression,
  attr: string,
): boolean {
  if ("and" in expr) {
    return expr.and.some((child) => hasAttribute(child, attr));
  }
  if ("or" in expr) {
    return expr.or.some((child) => hasAttribute(child, attr));
  }
  return expr.attr === attr;
}
