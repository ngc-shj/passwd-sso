/**
 * SCIM PATCH operation parser (RFC 7644 §3.5.2).
 *
 * Pure function — no Prisma / DB dependencies.
 * Depends only on ORG_ROLE_VALUES constant for group membership validation.
 */

// ── Types ─────────────────────────────────────────────────────

export type PatchOp = "add" | "replace" | "remove";

export interface ScimPatchOperation {
  op: PatchOp;
  path?: string;
  value?: unknown;
}

/**
 * Parsed result for a User PATCH request.
 * Each field is present only if the PATCH modifies it.
 */
export interface UserPatchResult {
  active?: boolean;
  name?: string;
}

/**
 * A single member add/remove action for Group PATCH.
 */
export interface GroupMemberAction {
  op: "add" | "remove";
  userId: string;
}

// ── User PATCH ────────────────────────────────────────────────

/**
 * Parse SCIM PATCH operations for a User resource.
 *
 * Supported paths:
 * - `active` (replace/add) → boolean
 * - `name.formatted` (replace/add) → string
 *
 * Unsupported paths → thrown error.
 */
export function parseUserPatchOps(
  operations: ScimPatchOperation[],
): UserPatchResult {
  const result: UserPatchResult = {};

  for (const operation of operations) {
    const { op, path, value } = operation;

    if (op !== "add" && op !== "replace") {
      throw new PatchParseError(`Unsupported op "${op}" for User resource`);
    }

    if (path === "active") {
      if (typeof value !== "boolean") {
        throw new PatchParseError("active must be a boolean");
      }
      result.active = value;
      continue;
    }

    if (path === "name.formatted") {
      if (typeof value !== "string") {
        throw new PatchParseError("name.formatted must be a string");
      }
      result.name = value;
      continue;
    }

    // Handle object-form: op=replace, path=undefined, value={active: false, ...}
    if (!path && typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      if ("active" in obj) {
        if (typeof obj.active !== "boolean") {
          throw new PatchParseError("active must be a boolean");
        }
        result.active = obj.active;
      }
      if ("name" in obj && typeof obj.name === "object" && obj.name !== null) {
        const nameObj = obj.name as Record<string, unknown>;
        if ("formatted" in nameObj && typeof nameObj.formatted === "string") {
          result.name = nameObj.formatted;
        }
      }
      continue;
    }

    throw new PatchParseError(
      `Unsupported PATCH path "${path ?? "(none)"}" for User resource`,
    );
  }

  return result;
}

// ── Group PATCH ───────────────────────────────────────────────

/**
 * Parse SCIM PATCH operations for a Group resource.
 *
 * Supported:
 * - `add` with path `members` → list of `{ value: userId }`
 * - `remove` with path `members` → list of `{ value: userId }`
 * - `remove` with path `members[value eq "userId"]` → single member
 *
 * Unsupported paths → thrown error.
 */
export function parseGroupPatchOps(
  operations: ScimPatchOperation[],
): GroupMemberAction[] {
  const actions: GroupMemberAction[] = [];

  for (const operation of operations) {
    const { op, path, value } = operation;

    if (op === "add" && path === "members") {
      const members = parseMemberValues(value);
      for (const userId of members) {
        actions.push({ op: "add", userId });
      }
      continue;
    }

    if (op === "remove" && path === "members") {
      const members = parseMemberValues(value);
      for (const userId of members) {
        actions.push({ op: "remove", userId });
      }
      continue;
    }

    // Azure AD style: remove with path like `members[value eq "userId"]`
    if (op === "remove" && path?.startsWith("members[")) {
      const match = path.match(
        /^members\[value\s+eq\s+"([^"]+)"\]$/,
      );
      if (!match) {
        throw new PatchParseError(
          `Invalid members filter syntax: ${path}`,
        );
      }
      actions.push({ op: "remove", userId: match[1] });
      continue;
    }

    throw new PatchParseError(
      `Unsupported PATCH op "${op}" with path "${path ?? "(none)"}" for Group resource`,
    );
  }

  return actions;
}

// ── Helpers ───────────────────────────────────────────────────

function parseMemberValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PatchParseError("members value must be an array");
  }
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("value" in item) ||
      typeof (item as Record<string, unknown>).value !== "string"
    ) {
      throw new PatchParseError(
        "Each member must be an object with a string 'value' field",
      );
    }
    return (item as { value: string }).value;
  });
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}
