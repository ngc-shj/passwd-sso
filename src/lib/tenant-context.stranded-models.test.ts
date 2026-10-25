/**
 * The member set `countStrandedRows` reports is DERIVED from the schema, not
 * listed in a docstring.
 *
 * Round 4 found the first version counting `passwordEntry` / `tag` / `folder`
 * and nothing else, so `{0,0,0}` read as "nothing stranded" for a user whose
 * passkeys, tokens and sessions were all still filed under the tenant that
 * released them. The remedy is not a longer hand-list — that is the same defect
 * one iteration later — but this test: every model declaring `tenantId` beside a
 * user column must be either counted or explicitly excluded WITH A REASON, so a
 * model added to the schema later fails here instead of reporting a silent zero.
 * A user column is found by its relation to `User` (`user-bound-models.ts`), not
 * by its name.
 */
import { describe, it, expect } from "vitest";
import { STRANDED_COUNTERS } from "./tenant-context";
import { handleOf, parseSchemaModels, userBoundModels } from "@/__tests__/helpers/user-bound-models";

/**
 * Models the realignment does NOT strand, each with the reason it is out.
 *
 * A reason is mandatory: the exclusion is the deliberate act, and it is what the
 * next reviewer reads instead of re-deriving the judgement.
 */
const NOT_STRANDED: Record<string, string> = {
  AuditLog:
    "the trail itself, moved by audit_log_tenant_migrate rather than owned by the user",
  TenantMember: "the membership, not data filed under one",
  TeamMember: "a membership in a team, same reason",
  TeamPasswordEntry: "team-owned; createdById / updatedById are provenance, not ownership",
  TeamPasswordEntryHistory: "team-owned; changedById is provenance",
  TeamInvitation: "team-owned; invitedById is who sent it",
  ScimToken: "tenant-owned credential; createdById is who minted it",
  ServiceAccount: "tenant-owned identity; createdById is who created it",
  McpClient: "tenant-owned OAuth client; createdById is who registered it",
  MasterKeyRotation: "tenant-owned operation; every user column is who initiated, approved, executed or revoked it",
  AdminVaultReset:
    "the tenant's action on the user (targetUserId), authorised by its admins and executable only while the target's vault is filed under that tenant",
  PersonalLogAccessGrant:
    "the tenant's break-glass grant over the user's logs (targetUserId), usable only while the target is its active member",
  AccessRequest:
    "a request against the tenant's service account (requesterUserId), pinned to its tenant by the composite FK",
};

describe("countStrandedRows member set", () => {
  const models = parseSchemaModels();
  const bound = userBoundModels(models);

  it("parsed a schema with models in it", () => {
    // "Examined nothing" must not be spelled like "found nothing": a parse that
    // silently returned an empty map would make every assertion below vacuous.
    expect(models.size).toBeGreaterThan(20);
    expect(models.has("User")).toBe(true);
  });

  it("finds a user column by its relation to User, whatever it is named", () => {
    // The columns a name list missed (claim-binding review round 4, S10).
    expect(bound.get("OperatorToken")).toContain("subjectUserId");
    expect(bound.get("AdminVaultReset")).toContain("targetUserId");
    expect(bound.get("PersonalLogAccessGrant")).toContain("targetUserId");
    expect(bound.get("AccessRequest")).toContain("requesterUserId");
    // And the relation-less ones through FK_LESS_USER_COLUMNS.
    expect(bound.get("McpAccessToken")).toEqual(["userId"]);
  });

  it("counts or excludes every tenant-scoped model a user owns", () => {
    const derived = [...bound.keys()];
    expect(derived.length).toBeGreaterThan(0);

    const counted = new Set(Object.keys(STRANDED_COUNTERS));
    const unaccounted = derived.filter(
      (model) => !counted.has(handleOf(model)) && !(model in NOT_STRANDED),
    );
    expect(
      unaccounted,
      "a model declaring tenantId beside a user column must be counted by " +
        "STRANDED_COUNTERS or named in NOT_STRANDED with a reason — otherwise a " +
        "realignment reports zero for rows it stranded",
    ).toEqual([]);
  });

  it("counts nothing the schema does not put in the class", () => {
    // The reverse direction. A counter for a model that is not tenant-scoped, or
    // that the user does not own, counts rows no realignment can strand — and
    // reads to the operator as evidence about a table it is not about.
    const derivedHandles = new Set([...bound.keys()].map(handleOf));
    const strays = Object.keys(STRANDED_COUNTERS).filter((h) => !derivedHandles.has(h));
    expect(strays).toEqual([]);
  });

  it("excludes nothing that is not in the class, and gives every exclusion a reason", () => {
    const derived = new Set(bound.keys());
    for (const [model, reason] of Object.entries(NOT_STRANDED)) {
      expect(derived.has(model), `${model} is excluded but not in the class`).toBe(true);
      expect(reason.length, `${model} is excluded with no reason`).toBeGreaterThan(10);
    }
  });
});
