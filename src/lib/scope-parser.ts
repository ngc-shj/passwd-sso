/**
 * Scope parser for service account and MCP tokens.
 *
 * Scope format: `resource:action[:qualifier]`
 * - `passwords:read` — access all password entries
 * - `passwords:read:folder/<uuid>` — access entries in a specific folder
 * - `team:<uuid>:passwords:read` — access team entries
 *
 * Prefix match semantics:
 * - `passwords:read` includes `passwords:read:folder/<uuid>` (superset)
 * - `passwords:read:folder/abc` is a subset of `passwords:read`
 *
 * Existing API Key / Extension Token use flat scopes and are NOT affected.
 */

import { z } from "zod";

export interface ParsedScope {
  resource: string;
  action: string;
  qualifier?: string;
  raw: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const qualifierSchema = z.string().refine(
  (q) => {
    // qualifier format: type/<uuid>
    const parts = q.split("/");
    if (parts.length !== 2) return false;
    const [type, id] = parts;
    if (!["folder", "tag", "team"].includes(type)) return false;
    return UUID_RE.test(id);
  },
  { message: "Qualifier must be type/<uuid> where type is folder, tag, or team" },
);

/**
 * Parse a single scope token (e.g., `passwords:read:folder/<uuid>`).
 * Returns null if the scope is malformed.
 */
export function parseScope(raw: string): ParsedScope | null {
  const parts = raw.split(":");
  if (parts.length < 2) return null;

  // Handle team-scoped: team:<uuid>:resource:action
  if (parts[0] === "team" && parts.length >= 4) {
    const teamId = parts[1];
    if (!UUID_RE.test(teamId)) return null;
    const resource = parts[2];
    const action = parts[3];
    const qualifier = parts.length > 4 ? parts.slice(4).join(":") : undefined;
    return { resource: `team:${teamId}:${resource}`, action, qualifier, raw };
  }

  const resource = parts[0];
  const action = parts[1];
  const qualifier = parts.length > 2 ? parts.slice(2).join(":") : undefined;

  if (qualifier) {
    const result = qualifierSchema.safeParse(qualifier);
    if (!result.success) return null;
  }

  return { resource, action, qualifier, raw };
}

/**
 * Parse a CSV scope string into an array of ParsedScope.
 * Invalid scopes are silently dropped.
 */
export function parseScopes(csv: string): ParsedScope[] {
  const out: ParsedScope[] = [];
  for (const raw of csv.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = parseScope(trimmed);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Check if a set of scopes satisfies a required scope.
 *
 * Uses prefix match: `passwords:read` satisfies `passwords:read:folder/<uuid>`.
 * A qualified scope `passwords:read:folder/abc` does NOT satisfy unqualified `passwords:read`.
 */
export function scopeSatisfies(
  grantedScopes: ParsedScope[],
  required: ParsedScope,
): boolean {
  for (const granted of grantedScopes) {
    // Same resource and action
    if (granted.resource !== required.resource || granted.action !== required.action) {
      continue;
    }
    // Unqualified grant covers all qualifiers (superset)
    if (!granted.qualifier) return true;
    // Both qualified — must match exactly
    if (granted.qualifier === required.qualifier) return true;
  }
  return false;
}

/**
 * Check if a CSV scope string satisfies a required scope string.
 * Convenience wrapper for scopeSatisfies with raw strings.
 */
export function scopeStringSatisfies(
  grantedCsv: string,
  requiredRaw: string,
): boolean {
  const granted = parseScopes(grantedCsv);
  const required = parseScope(requiredRaw);
  if (!required) return false;
  return scopeSatisfies(granted, required);
}
