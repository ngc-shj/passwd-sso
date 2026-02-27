import type { TeamRole } from "@prisma/client";
import { v5 as uuid5 } from "uuid";

// App-specific UUID v5 namespace for SCIM Group IDs — do NOT change once deployed
const SCIM_GROUP_NAMESPACE = "125b7a5b-23f9-495c-bd0a-369bae10337e";

/**
 * DB row shape expected by `userToScimUser()`.
 * Keeps the serializer decoupled from Prisma's generated types.
 */
export interface ScimUserInput {
  /** TeamMember.userId (stored in legacy teamMember table for backward compatibility) */
  userId: string;
  email: string;
  name: string | null;
  deactivatedAt: Date | null;
  /** ScimExternalMapping.externalId — may be absent for non-SCIM members */
  externalId?: string | null;
}

/** SCIM User resource (RFC 7643 §4.1). */
export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: { formatted: string };
  active: boolean;
  meta: {
    resourceType: "User";
    location: string;
  };
}

/**
 * Convert a DB user + membership to a SCIM User resource.
 *
 * @param input - Joined team membership + User + optional ScimExternalMapping data
 * @param baseUrl - SCIM base URL, e.g. `https://example.com/api/scim/v2`
 */
export function userToScimUser(
  input: ScimUserInput,
  baseUrl: string,
): ScimUserResource {
  const resource: ScimUserResource = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: input.userId,
    userName: input.email,
    name: { formatted: input.name ?? "" },
    active: input.deactivatedAt === null,
    meta: {
      resourceType: "User",
      location: `${baseUrl}/Users/${input.userId}`,
    },
  };
  if (input.externalId) {
    resource.externalId = input.externalId;
  }
  return resource;
}

// ── Groups ──────────────────────────────────────────────────────

/** SCIM Group member reference. */
interface ScimGroupMember {
  value: string;
  display: string;
  $ref: string;
}

/** SCIM Group resource (RFC 7643 §4.2). */
export interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: ScimGroupMember[];
  meta: {
    resourceType: "Group";
    location: string;
  };
}

/**
 * Deterministic UUID for a (teamId, roleName) pair.
 * IdP expects stable Group IDs across requests.
 */
export function roleGroupId(teamId: string, role: TeamRole): string {
  return uuid5(`${teamId}:${role}`, SCIM_GROUP_NAMESPACE);
}

/** Member data needed by `roleToScimGroup()`. */
export interface ScimGroupMemberInput {
  userId: string;
  email: string;
}

/**
 * Convert a team role to a SCIM Group resource.
 */
export function roleToScimGroup(
  teamId: string,
  role: TeamRole,
  members: ScimGroupMemberInput[],
  baseUrl: string,
): ScimGroupResource {
  const id = roleGroupId(teamId, role);
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id,
    displayName: role,
    members: members.map((m) => ({
      value: m.userId,
      display: m.email,
      $ref: `${baseUrl}/Users/${m.userId}`,
    })),
    meta: {
      resourceType: "Group",
      location: `${baseUrl}/Groups/${id}`,
    },
  };
}
