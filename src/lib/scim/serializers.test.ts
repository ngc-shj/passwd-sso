import { describe, it, expect } from "vitest";
import { userToScimUser, roleToScimGroup, roleGroupId } from "./serializers";

const BASE_URL = "https://example.com/api/scim/v2";

describe("userToScimUser", () => {
  it("serializes an active user", () => {
    const result = userToScimUser(
      {
        userId: "user-1",
        email: "test@example.com",
        name: "Test User",
        deactivatedAt: null,
      },
      BASE_URL,
    );

    expect(result.schemas).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
    ]);
    expect(result.id).toBe("user-1");
    expect(result.userName).toBe("test@example.com");
    expect(result.name.formatted).toBe("Test User");
    expect(result.active).toBe(true);
    expect(result.meta.resourceType).toBe("User");
    expect(result.meta.location).toBe(`${BASE_URL}/Users/user-1`);
    expect(result.externalId).toBeUndefined();
  });

  it("serializes a deactivated user with active=false", () => {
    const result = userToScimUser(
      {
        userId: "user-2",
        email: "deactivated@example.com",
        name: null,
        deactivatedAt: new Date("2024-01-01"),
      },
      BASE_URL,
    );

    expect(result.active).toBe(false);
    expect(result.name.formatted).toBe("");
  });

  it("includes externalId when present", () => {
    const result = userToScimUser(
      {
        userId: "user-3",
        email: "ext@example.com",
        name: "External",
        deactivatedAt: null,
        externalId: "ext-123",
      },
      BASE_URL,
    );

    expect(result.externalId).toBe("ext-123");
  });
});

describe("roleToScimGroup", () => {
  it("serializes a group with members", () => {
    const result = roleToScimGroup(
      "org-1",
      "ADMIN",
      [{ userId: "user-1", email: "admin@example.com" }],
      BASE_URL,
    );

    expect(result.schemas).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:Group",
    ]);
    expect(result.displayName).toBe("ADMIN");
    expect(result.members).toHaveLength(1);
    expect(result.members[0].value).toBe("user-1");
    expect(result.members[0].display).toBe("admin@example.com");
    expect(result.members[0].$ref).toBe(`${BASE_URL}/Users/user-1`);
    expect(result.meta.resourceType).toBe("Group");
  });
});

describe("roleGroupId", () => {
  it("returns deterministic UUID for the same org+role", () => {
    const id1 = roleGroupId("org-1", "ADMIN");
    const id2 = roleGroupId("org-1", "ADMIN");
    expect(id1).toBe(id2);
  });

  it("returns different UUIDs for different roles", () => {
    const id1 = roleGroupId("org-1", "ADMIN");
    const id2 = roleGroupId("org-1", "MEMBER");
    expect(id1).not.toBe(id2);
  });

  it("returns different UUIDs for different orgs", () => {
    const id1 = roleGroupId("org-1", "ADMIN");
    const id2 = roleGroupId("org-2", "ADMIN");
    expect(id1).not.toBe(id2);
  });
});
